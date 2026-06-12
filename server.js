const express = require('express');
const session = require('express-session');
const path = require('path');
const QRCode = require('qrcode');
const nodemailer = require('nodemailer');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(session({
  secret: 'credity-secret-key-2026',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false }
}));

// ==================== MAILER ====================
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: 'credifysupport@gmail.com',
    pass: 'wuae yhmw jhqn nynz' // Recommendation: Move this to a .env file for security
  }
});

// ==================== DATABASE ====================
let users = [
  { id: 1, email: 'teacher@school.com', password: 'pass123', role: 'teacher', name: 'Ms. Johnson' },
  { id: 2, email: 'student@school.com', password: 'pass123', role: 'student', name: 'Alex Rivera' }
];

let credentialTemplates = [];
let issuedCredentials = [];
let events = [];
let tests = [];
let networkLogs = [];

// ==================== HELPERS ====================
async function generateQR(text) {
  try {
    return await QRCode.toDataURL(text);
  } catch (err) {
    console.error("QR Generation failed:", err);
    return null;
  }
}

function generateCredentialHash(userId, assessmentId) {
  const raw = `${userId}-${assessmentId}-${Date.now()}`;
  return crypto.createHash('sha256').update(raw).digest('hex').substring(0, 18);
}

async function sendEmail(to, subject, html) {
  try {
    await transporter.sendMail({
      from: '"Credity" <credifysupport@gmail.com>',
      to,
      subject,
      html
    });
  } catch (err) {
    console.log('Email error:', err.message);
  }
}

// ==================== AUTH ROUTES ====================
app.get('/', (req, res) => {
  if (req.session.user) {
    return res.redirect(req.session.user.role === 'teacher' ? '/teacher-dashboard' : '/student-dashboard');
  }
  res.render('index', { error: null });
});

app.post('/login', (req, res) => {
  const { email, password, role } = req.body;

  if (email === 'admin' && password === 'monterysasd') {
    req.session.user = { id: 0, email: 'admin', role: 'teacher', name: 'Admin' };
    return res.redirect('/admin');
  }

  const user = users.find(u => u.email === email && u.password === password && u.role === role);
  if (user) {
    req.session.user = user;
    return res.redirect(user.role === 'teacher' ? '/teacher-dashboard' : '/student-dashboard');
  }
  res.render('index', { error: 'Invalid credentials.' });
});

app.post('/signup', async (req, res) => {
  const { name, email, password, role } = req.body;
  if (users.find(u => u.email === email)) return res.render('index', { error: 'Email exists.' });

  const newUser = { id: users.length + 1, email, password, role, name };
  users.push(newUser);
  req.session.user = newUser;
  await sendEmail(email, 'Welcome to Credity', `<p>Hello ${name}, your account was created.</p>`);
  res.redirect(role === 'teacher' ? '/teacher-dashboard' : '/student-dashboard');
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

// ==================== DASHBOARDS ====================
app.get('/student-dashboard', (req, res) => {
  if (!req.session.user || req.session.user.role !== 'student') return res.redirect('/');

  const userCredentials = issuedCredentials.filter(c => c.userId === req.session.user.id);
  const upcomingExams = tests
    .filter(t => t.examStartTime)
    .map(t => {
      const start = new Date(t.examStartTime);
      const now = new Date();
      const diff = start.getTime() - now.getTime();
      return { ...t, countdown: diff > 0 ? Math.floor(diff / 1000) : 0 };
    });

  res.render('student-dashboard', { 
    user: req.session.user, 
    issuedCredentials: userCredentials, 
    tests, 
    events,
    upcomingExams 
  });
});

app.get('/teacher-dashboard', (req, res) => {
  if (!req.session.user || req.session.user.role !== 'teacher') return res.redirect('/');
  res.render('teacher-dashboard', { user: req.session.user, badges: credentialTemplates, tests, events });
});

app.get('/admin', (req, res) => {
  if (!req.session.user || req.session.user.role !== 'teacher') return res.redirect('/');
  res.render('admin', { user: req.session.user, badges: credentialTemplates, tests, issuedBadges: issuedCredentials, users });
});

// ==================== ENHANCED TEST CREATION ====================

// GET: Render the Assessment Creation UI
app.get('/assessment', (req, res) => {
  if (!req.session.user || req.session.user.role !== 'teacher') return res.redirect('/');
  res.render('assessment'); // Ensure your enhanced creator UI is saved as views/assessment.ejs
});

// POST: Handle the Assessment Creation Submission
app.post('/assessment', (req, res) => {
  if (!req.session.user || req.session.user.role !== 'teacher') return res.redirect('/');

  let questions = [];
  try { 
    questions = JSON.parse(req.body.questions || '[]'); 
  } catch (e) {
    console.error("Failed to parse questions data.");
  }

  const hasGraphData = questions.some(q => q.graphData !== undefined);

  const newTest = {
    id: tests.length + 1,
    title: req.body.title || 'Untitled Assessment',
    questions,
    questionType: req.body.questionType || 'mcq',
    timePerQuestion: parseInt(req.body.timePerQuestion) || 60,
    topics: req.body.topics || '',
    resources: req.body.resources || '',
    hasGraph: hasGraphData,
    calculatorEnabled: req.body.calculatorEnabled !== 'false',
    attachedCredentialTemplateId: req.body.attachedCredentialTemplateId ? parseInt(req.body.attachedCredentialTemplateId) : null,
    examStartTime: req.body.examStartTime || null,
    teacherTimezone: req.body.teacherTimezone || 'Asia/Dubai',
    showResultsAfterReview: req.body.showResultsAfterReview === 'true',
    networkLoggingEnabled: true,
    createdBy: req.session.user.name,
    dateCreated: new Date().toISOString()
  };

  tests.push(newTest);

  if (newTest.examStartTime) {
    console.log(`[SCHEDULED] Exam "${newTest.title}" starts at ${newTest.examStartTime} (${newTest.teacherTimezone})`);
  }

  res.redirect(req.session.user.email === 'admin' ? '/admin' : '/teacher-dashboard');
});

// ==================== TAKE TEST ====================
app.get('/take-test/:id', (req, res) => {
  if (!req.session.user || req.session.user.role !== 'student') return res.redirect('/');

  const test = tests.find(t => t.id == req.params.id);
  if (!test) return res.redirect('/student-dashboard');

  req.session.examInProgress = true;
  req.session.currentTestId = test.id;
  req.session.examStartTime = Date.now();

  res.render('take-test', { user: req.session.user, test }); // Saved as take-test.ejs
});

// ==================== SUBMIT TEST ====================
app.post('/submit-test/:id', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'student') return res.redirect('/');

  const testId = parseInt(req.params.id);
  const test = tests.find(t => t.id === testId);
  if (!test) return res.redirect('/student-dashboard');

  const score = parseInt(req.body.score) || 85;
  const passed = score >= 70;

  if (passed && test.attachedCredentialTemplateId) {
    const template = credentialTemplates.find(t => t.templateId === test.attachedCredentialTemplateId);
    if (template) {
      const issuedId = issuedCredentials.length + 1;
      const verifyHash = generateCredentialHash(req.session.user.id, testId);

      const newCred = {
        ...template,
        issuedId,
        verifyHash,
        shareLink: `https://credity.ink/verify/${verifyHash}`,
        userId: req.session.user.id,
        studentName: req.session.user.name,
        issueDate: new Date().toLocaleDateString(),
        status: 'passed',
        score,
        submittedAt: new Date()
      };

      if (template.useQR) {
        newCred.qrCode = await generateQR(newCred.shareLink);
      }

      issuedCredentials.push(newCred);

      await sendEmail(req.session.user.email, `Your Results - ${test.title}`, `
        <h2>Congratulations ${req.session.user.name}!</h2>
        <p>You scored <strong>${score}%</strong> on "${test.title}".</p>
        <p>Your credential is ready: <a href="${newCred.shareLink}">${newCred.shareLink}</a></p>
      `);
    }
  }

  if (test.networkLoggingEnabled) {
    networkLogs.push({
      testId,
      userId: req.session.user.id,
      timestamp: new Date(),
      userAgent: req.headers['user-agent'],
      ip: req.ip
    });
  }

  req.session.examInProgress = false;
  req.session.currentTestId = null;

  res.redirect('/student-dashboard');
});

// ==================== VERIFICATION & LOGS ====================
app.get('/verify/:hash', (req, res) => {
  const cred = issuedCredentials.find(c => c.verifyHash === req.params.hash);
  res.render('verify', { credential: cred, status: cred ? 'valid' : 'invalid' });
});

app.get('/network-logs/:testId', (req, res) => {
  if (!req.session.user || req.session.user.role !== 'teacher') return res.redirect('/');
  const logs = networkLogs.filter(l => l.testId == req.params.testId);
  res.json(logs);
});

// ==================== SERVER START ====================
app.listen(PORT, () => {
  console.log(`🚀 Credity running on port ${PORT}`);
});
