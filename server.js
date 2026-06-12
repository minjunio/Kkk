const express = require('express');
const session = require('express-session');
const path = require('path');
const QRCode = require('qrcode');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;

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

// Gmail email setup (password already added)
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: 'credifysupport@gmail.com',
    pass: 'wuae yhmw jhqn nynz'
  }
});

let users = [
  { id: 1, email: 'teacher@school.com', password: 'pass123', role: 'teacher', name: 'Ms. Johnson' },
  { id: 2, email: 'student@school.com', password: 'pass123', role: 'student', name: 'Alex Rivera' }
];

let badges = [];
let events = [];
let tests = [];
let issuedBadges = [];

async function generateQR(text) {
  return await QRCode.toDataURL(text);
}

async function sendConfirmationEmail(user) {
  try {
    await transporter.sendMail({
      from: '"Credity Support" <credifysupport@gmail.com>',
      to: user.email,
      subject: 'Welcome to Credity – Account Created',
      html: `<p>Hello ${user.name},<br>Your account has been created successfully.</p>`
    });
    console.log('Email sent to', user.email);
  } catch (err) {
    console.log('Email error (non-blocking):', err.message);
  }
}

app.get('/', (req, res) => {
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
  } else {
    res.render('index', { error: 'Invalid credentials' });
  }
});

app.post('/signup', async (req, res) => {
  const { name, email, password, role } = req.body;

  if (users.find(u => u.email === email)) {
    return res.render('index', { error: 'Email already exists' });
  }

  const newUser = { id: users.length + 1, email, password, role, name };
  users.push(newUser);
  req.session.user = newUser;

  await sendConfirmationEmail(newUser);

  res.redirect(role === 'teacher' ? '/teacher-dashboard' : '/student-dashboard');
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

app.get('/student-dashboard', (req, res) => {
  if (!req.session.user || req.session.user.role !== 'student') return res.redirect('/');
  const userBadges = issuedBadges.filter(b => b.userId === req.session.user.id);
  res.render('student-dashboard', { user: req.session.user, badges: userBadges, events });
});

app.get('/teacher-dashboard', (req, res) => {
  if (!req.session.user || req.session.user.role !== 'teacher') return res.redirect('/');
  res.render('teacher-dashboard', { user: req.session.user, badges, events, tests });
});

app.get('/admin', (req, res) => {
  if (!req.session.user || req.session.user.role !== 'teacher') return res.redirect('/');
  res.render('admin', { user: req.session.user, badges, events, tests, issuedBadges });
});

app.post('/create-badge', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'teacher') return res.redirect('/');
  const { title, description, designColor, signature, type } = req.body;
  const newBadge = {
    id: badges.length + 1,
    title, description,
    designColor: designColor || '#3b82f6',
    signature: signature || req.session.user.name,
    type: type || 'badge',
    createdBy: req.session.user.name
  };
  newBadge.qrCode = await generateQR(`https://credity.ink/verify/${newBadge.id}`);
  badges.push(newBadge);
  res.redirect(req.session.user.email === 'admin' ? '/admin' : '/teacher-dashboard');
});

app.post('/post-event', (req, res) => {
  if (!req.session.user || req.session.user.role !== 'teacher') return res.redirect('/');
  events.push({
    id: events.length + 1,
    title: req.body.title,
    description: req.body.description,
    date: new Date().toISOString().split('T')[0]
  });
  res.redirect(req.session.user.email === 'admin' ? '/admin' : '/teacher-dashboard');
});

app.post('/create-test', (req, res) => {
  if (!req.session.user || req.session.user.role !== 'teacher') return res.redirect('/');
  let parsed = [];
  try { parsed = JSON.parse(req.body.questions || '[]'); } catch (e) {}
  tests.push({
    id: tests.length + 1,
    title: req.body.title,
    questions: parsed,
    createdBy: req.session.user.name
  });
  res.redirect(req.session.user.email === 'admin' ? '/admin' : '/teacher-dashboard');
});

app.get('/verify/:id', (req, res) => {
  const badge = badges.find(b => b.id == req.params.id);
  res.render('verify', { badge: badge || { title: 'Invalid' } });
});

app.listen(PORT, () => console.log(`Credity running on port ${PORT}`));