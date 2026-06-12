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
    pass: 'wuae yhmw jhqn nynz' // Move to .env in production
  }
});

// ==================== DATABASE (Mock) ====================
let users = [
  { id: 1, email: 'teacher@school.com', password: 'pass123', role: 'teacher', name: 'Ms. Johnson' },
  { id: 2, email: 'admin', password: 'admin', role: 'teacher', name: 'Admin' },
  { id: 3, email: 'student@school.com', password: 'pass123', role: 'student', name: 'Alex Rivera' }
];

let credentialTemplates = [];
let issuedCredentials = [];
let tests = [];
let events = [];
let networkLogs = [];

// ==================== HELPERS ====================
async function generateQR(text) {
  try { return await QRCode.toDataURL(text); } catch (err) { return null; }
}

function generateCredentialHash(userId, assessmentId) {
  const raw = `${userId}-${assessmentId}-${Date.now()}`;
  return crypto.createHash('sha256').update(raw).digest('hex').substring(0, 18);
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
  const user = users.find(u => u.email === email && u.password === password && (role ? u.role === role : true));
  
  if (user) {
    req.session.user = user;
    return res.redirect(user.role === 'teacher' ? '/teacher-dashboard' : '/student-dashboard');
  }
  res.render('index', { error: 'Invalid credentials.' });
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

// ==================== DASHBOARDS ====================
app.get('/student-dashboard', (req, res) => {
  if (!req.session.user || req.session.user.role !== 'student') return res.redirect('/');

  const userCredentials = issuedCredentials.filter(c => c.userId === req.session.user.id);
  const now = new Date().getTime();
  
  const availableExams = tests.map(t => {
    let status = 'open';
    if (!t.isOpenExam) {
      const start = new Date(t.startTime).getTime();
      const end = new Date(t.endTime).getTime();
      if (now < start) status = 'upcoming';
      else if (now > end) status = 'closed';
    }
    return { ...t, status };
  });

  res.render('student-dashboard', { 
    user: req.session.user, 
    issuedCredentials: userCredentials, 
    tests: availableExams,
    events
  });
});

app.get('/teacher-dashboard', (req, res) => {
  if (!req.session.user || req.session.user.role !== 'teacher') return res.redirect('/');
  
  // ISOLATE DATA: Only show tests and templates created by THIS teacher
  const myTests = tests.filter(t => t.teacherId === req.session.user.id);
  const myTemplates = credentialTemplates.filter(c => c.teacherId === req.session.user.id);

  res.render('teacher-dashboard', { user: req.session.user, badges: myTemplates, tests: myTests, events });
});

app.get('/admin', (req, res) => {
  if (!req.session.user || req.session.user.role !== 'teacher') return res.redirect('/');
  const myTests = tests.filter(t => t.teacherId === req.session.user.id);
  res.render('admin', { user: req.session.user, badges: credentialTemplates, tests: myTests, issuedBadges: issuedCredentials, users });
});

// ==================== CREDENTIAL CREATION ====================
app.post('/create-credential', (req, res) => {
  if (!req.session.user || req.session.user.role !== 'teacher') return res.redirect('/');
  
  const newTemplate = {
    templateId: credentialTemplates.length + 1,
    teacherId: req.session.user.id,
    type: req.body.type,
    title: req.body.title,
    designColor: req.body.designColor,
    assessmentId: req.body.assessmentId || null
  };
  
  credentialTemplates.push(newTemplate);
  res.redirect('/admin');
});

// ==================== ASSESSMENT BUILDER ====================
app.get('/assessment', (req, res) => {
  if (!req.session.user || req.session.user.role !== 'teacher') return res.redirect('/');
  
  // Pass ONLY the teacher's templates to the view so they can attach them
  const myTemplates = credentialTemplates.filter(c => c.teacherId === req.session.user.id);
  
  res.render('assessment', { user: req.session.user, userTemplates: myTemplates });
});

app.post('/assessment', (req, res) => {
  if (!req.session.user || req.session.user.role !== 'teacher') return res.redirect('/');

  let questions = [];
  try { questions = JSON.parse(req.body.questions || '[]'); } catch (e) { console.log(e); }

  const newTest = {
    id: tests.length + 1,
    teacherId: req.session.user.id, // ISOLATE TO TEACHER
    title: req.body.title || 'Untitled Assessment',
    questions,
    timePerQuestion: parseInt(req.body.timePerQuestion) || 60,
    isOpenExam: req.body.isOpenExam === 'true',
    startTime: req.body.startTime || null,
    endTime: req.body.endTime || null,
    requireFullScreen: req.body.requireFullScreen === 'true',
    attachedCredentialTemplateId: req.body.attachedCredentialTemplateId ? parseInt(req.body.attachedCredentialTemplateId) : null,
    dateCreated: new Date().toISOString()
  };

  tests.push(newTest);
  res.redirect('/teacher-dashboard');
});

app.listen(PORT, () => {
  console.log(`🚀 Credity running on port ${PORT}`);
});
