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
  
  // Only show tests that the student is allowed to see (open or scheduled)
  const upcomingExams = tests
    .map(t => {
      let countdown = 0;
      if (t.examStartTime && !t.isOpen) {
        const start = new Date(t.examStartTime);
        const now = new Date();
        const diff = start.getTime() - now.getTime();
        countdown = diff > 0 ? Math.floor(diff / 1000) : 0;
      }
      return { ...t, countdown };
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
  
  // Isolate tests and badges to this specific teacher
  const teacherTests = tests.filter(t => t.teacherId === req.session.user.id);
  const teacherBadges = credentialTemplates.filter(t => t.teacherId === req.session.user.id);
  
  res.render('teacher-dashboard', { 
    user: req.session.user, 
    badges: teacherBadges, 
    tests: teacherTests, 
    events 
  });
});

app.get('/admin', (req, res) => {
  if (!req.session.user || req.session.user.role !== 'teacher') return res.redirect('/');
  
  // Admin route - isolating view to credentials and tests made by this account
  const teacherTests = tests.filter(t => t.teacherId === req.session.user.id);
  const teacherBadges = credentialTemplates.filter(t => t.teacherId === req.session.user.id);
  
  res.render('admin', { 
    user: req.session.user, 
    badges: teacherBadges, 
    tests: teacherTests, 
    issuedBadges: issuedCredentials, 
    users 
  });
});

// ==================== CREDENTIAL CREATION (Admin Page) ====================
app.post('/create-credential', (req, res) => {
  if (!req.session.user || req.session.user.role !== 'teacher') return res.redirect('/');

  const newTemplate = {
    templateId: credentialTemplates.length + 1,
    teacherId: req.session.user.id, // Bound strictly to the creating teacher
    type: req.body.type,
    assessmentId: req.body.assessmentId ? parseInt(req.body.assessmentId) : null,
    title: req.body.title,
    designColor: req.body.designColor,
    description: req.body.description,
    signature: req.body.signature,
    badgeIcon: req.body.badgeIcon,
    createdAt: new Date().toISOString()
  };

  credentialTemplates.push(newTemplate);

  // If the teacher linked this credential to a specific test, update that test
  if (newTemplate.assessmentId) {
    const test = tests.find(t => t.id === newTemplate.assessmentId && t.teacherId === req.session.user.id);
    if (test) {
      test.attachedCredentialTemplateId = newTemplate.templateId;
    }
  }

  res.redirect(req.session.user.email === 'admin' ? '/admin' : '/teacher-dashboard');
});

// ==================== ENHANCED TEST CREATION ====================
app.get('/assessment', (req, res) => {
  if (!req.session.user || req.session.user.role !== 'teacher') return res.redirect('/');
  
  // Pass teacher's own templates to the UI so they only pick from theirs
  const teacherTemplates = credentialTemplates.filter(t => t.teacherId === req.session.user.id);
  
  res.render('assessment', { templates: teacherTemplates, user: req.session.user }); 
});

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
    teacherId: req.session.user.id, // Securely binds test to teacher
    title: req.body.title || 'Untitled Assessment',
    questions,
    questionType: req.body.questionType || 'mcq',
    timePerQuestion: parseInt(req.body.timePerQuestion) || 60,
    topics: req.body.topics || '',
    resources: req.body.resources || '',
    hasGraph: hasGraphData,
    calculatorEnabled: req.body.calculatorEnabled !== 'false',
    attachedCredentialTemplateId: req.body.attachedCredentialTemplateId ? parseInt(req.body.attachedCredentialTemplateId) : null,
    
    // Time constraint variables
    isOpen: req.body.isOpen === 'true', // If true, exam can be taken anytime
    examStartTime: req.body.examStartTime || null,
    examEndTime: req.body.examEndTime || null,
    teacherTimezone: req.body.teacherTimezone || 'Asia/Dubai',
    
    showResultsAfterReview: req.body.showResultsAfterReview === 'true',
    networkLoggingEnabled: true,
    createdBy: req.session.user.name,
    dateCreated: new Date().toISOString()
  };

  tests.push(newTest);

  if (newTest.examStartTime && !newTest.isOpen) {
    console.log(`[SCHEDULED] Exam "${newTest.title}" window starts at ${newTest.examStartTime} (${newTest.teacherTimezone})`);
  }

  res.redirect(req.session.user.email === 'admin' ? '/admin' : '/teacher-dashboard');
});

// ==================== TAKE TEST ====================
app.get('/take-test/:id', (req, res) => {
  if (!req.session.user || req.session.user.role !== 'student') return res.redirect('/');

  const test = tests.find(t => t.id == req.params.id);
  if (!test) return res.redirect('/student-dashboard');

  // Verify time logic
  if (!test.isOpen) {
    const now = new Date().getTime();
    if (test.examStartTime && now < new Date(test.examStartTime).getTime()) {
      return res.status(403).send("<h1>Exam has not started yet.</h1><p>Please return to your dashboard and wait for the start time.</p>");
    }
    if (test.examEndTime && now > new Date(test.examEndTime).getTime()) {
      return res.status(403).send("<h1>Exam window closed.</h1><p>The time window for this assessment has passed.</p>");
    }
  }

  req.session.examInProgress = true;
  req.session.currentTestId = test.id;
  req.session.examStartTime = Date.now();

  res.render('take-test', { user: req.session.user, test });
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
  
  // Verify the requesting teacher owns the test before showing logs
  const test = tests.find(t => t.id == req.params.testId);
  if (!test || test.teacherId !== req.session.user.id) {
    return res.status(403).json({ error: "Unauthorized access to these logs." });
  }

  const logs = networkLogs.filter(l => l.testId == req.params.testId);
  res.json(logs);
});

// ==================== SERVER START ====================
app.listen(PORT, () => {
  console.log(`🚀 Credity running on port ${PORT}`);
});
