const express = require('express');
const session = require('express-session');
const path = require('path');
const QRCode = require('qrcode'); // For QR generation

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(session({
  secret: 'credity-secret-key',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false }
}));

// Fake Data (in-memory for demo)
let users = [
  { id: 1, email: 'teacher@school.com', password: 'pass123', role: 'teacher', name: 'Ms. Johnson' },
  { id: 2, email: 'student@school.com', password: 'pass123', role: 'student', name: 'Alex Rivera' }
];

let badges = [];
let events = [];
let tests = [];
let issuedBadges = [];

// Helper: Generate QR
async function generateQR(text) {
  return await QRCode.toDataURL(text);
}

// Routes
app.get('/', (req, res) => {
  res.render('index', { error: null });
});

app.post('/login', (req, res) => {
  const { email, password, role } = req.body;
  const user = users.find(u => u.email === email && u.password === password && u.role === role);
  if (user) {
    req.session.user = user;
    if (role === 'teacher') {
      res.redirect('/teacher-dashboard');
    } else {
      res.redirect('/student-dashboard');
    }
  } else {
    res.render('index', { error: 'Invalid credentials or role' });
  }
});

app.post('/signup', (req, res) => {
  const { name, email, password, role } = req.body;
  if (users.find(u => u.email === email)) {
    return res.render('index', { error: 'Email already exists' });
  }
  const newUser = { id: users.length + 1, email, password, role, name };
  users.push(newUser);
  req.session.user = newUser;
  if (role === 'teacher') {
    res.redirect('/teacher-dashboard');
  } else {
    res.redirect('/student-dashboard');
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

// Student Dashboard
app.get('/student-dashboard', (req, res) => {
  if (!req.session.user || req.session.user.role !== 'student') return res.redirect('/');
  const userBadges = issuedBadges.filter(b => b.userId === req.session.user.id);
  res.render('student-dashboard', { user: req.session.user, badges: userBadges, events });
});

// Teacher Dashboard (Admin)
app.get('/teacher-dashboard', (req, res) => {
  if (!req.session.user || req.session.user.role !== 'teacher') return res.redirect('/');
  res.render('teacher-dashboard', { user: req.session.user, badges, events, tests });
});

// Create Badge/Certificate (Teacher)
app.post('/create-badge', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'teacher') return res.redirect('/');
  const { title, description, designColor, logoUrl, signature, type } = req.body;
  const newBadge = {
    id: badges.length + 1,
    title,
    description,
    designColor: designColor || '#3b82f6',
    logoUrl: logoUrl || 'https://via.placeholder.com/100',
    signature: signature || 'Teacher Signature',
    type: type || 'badge', // badge or certificate
    createdBy: req.session.user.name,
    qrCode: null
  };
  const qrText = `https://credity.ink/verify/${newBadge.id}`;
  newBadge.qrCode = await generateQR(qrText);
  badges.push(newBadge);
  res.redirect('/teacher-dashboard');
});

// Post Event (Teacher)
app.post('/post-event', (req, res) => {
  if (!req.session.user || req.session.user.role !== 'teacher') return res.redirect('/');
  const { title, description, specialBadgeId } = req.body;
  events.push({
    id: events.length + 1,
    title,
    description,
    specialBadgeId: specialBadgeId || null,
    date: new Date().toISOString().split('T')[0]
  });
  res.redirect('/teacher-dashboard');
});

// Create Test (Teacher)
app.post('/create-test', (req, res) => {
  if (!req.session.user || req.session.user.role !== 'teacher') return res.redirect('/');
  const { title, questions } = req.body; // questions as JSON string or array
  let parsedQuestions = [];
  try {
    parsedQuestions = JSON.parse(questions || '[]');
  } catch (e) {}
  tests.push({
    id: tests.length + 1,
    title,
    questions: parsedQuestions, // [{q: '', type: 'mcq'/'frq', options?: [], timer?: 60, image?: ''}]
    createdBy: req.session.user.name
  });
  res.redirect('/teacher-dashboard');
});

// Verify Badge
app.get('/verify/:id', (req, res) => {
  const badge = badges.find(b => b.id == req.params.id);
  if (!badge) return res.send('Invalid badge');
  res.render('verify', { badge });
});

// Student: View/Claim Badge
app.post('/claim-badge/:id', (req, res) => {
  if (!req.session.user || req.session.user.role !== 'student') return res.redirect('/');
  const badge = badges.find(b => b.id == req.params.id);
  if (badge) {
    issuedBadges.push({
      id: issuedBadges.length + 1,
      badgeId: badge.id,
      userId: req.session.user.id,
      userName: req.session.user.name,
      issuedDate: new Date().toISOString().split('T')[0],
      qrCode: badge.qrCode
    });
  }
  res.redirect('/student-dashboard');
});

// Simple Test Taking (Student)
app.get('/take-test/:id', (req, res) => {
  if (!req.session.user || req.session.user.role !== 'student') return res.redirect('/');
  const test = tests.find(t => t.id == req.params.id);
  if (!test) return res.redirect('/student-dashboard');
  res.render('take-test', { test, user: req.session.user });
});

app.listen(PORT, () => {
  console.log(`Credity.ink running on port ${PORT}`);
});