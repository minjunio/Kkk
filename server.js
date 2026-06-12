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

// Gmail Transporter - Password added
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
  const mailOptions = {
    from: '"Credity Support" <credifysupport@gmail.com>',
    to: user.email,
    subject: 'Welcome to Credity – Your account is ready',
    html: `
      <div style="font-family: Inter, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
        <h2 style="color: #1e40af;">Welcome to Credity, ${user.name}!</h2>
        <p>Your account has been created successfully.</p>
        <p>You can now log in and start creating or earning verified skill badges and certificates.</p>
        <p style="margin-top: 30px;">
          <a href="https://credity.ink" style="background: #3b82f6; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px;">
            Go to Credity.ink
          </a>
        </p>
        <p style="color: #64748b; font-size: 13px; margin-top: 40px;">This is an automated confirmation email from Credity.</p>
      </div>
    `
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log('Confirmation email sent to:', user.email);
  } catch (error) {
    console.error('Email error:', error);
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
    res.render('index', { error: 'Invalid credentials or role' });
  }
});

app.post('/signup', async (req, res) => {
  const { name, email, password, role } = req.body;

  if (users.find(u => u.email === email)) {
    return res.render('index', { error: 'Email already exists' });
  }

  const newUser = {
    id: users.length + 1,
    email,
    password,
    role,
    name
  };

  users.push(newUser);
  req.session.user = newUser;

  await sendConfirmationEmail(newUser);

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
    title,
    description,
    designColor: designColor || '#3b82f6',
    signature: signature || req.session.user.name,
    type: type || 'badge',
    createdBy: req.session.user.name,
    qrCode: null
  };
  
  const qrText = `https://credity.ink/verify/${newBadge.id}`;
  newBadge.qrCode = await generateQR(qrText);
  badges.push(newBadge);
  
  res.redirect(req.session.user.email === 'admin' ? '/admin' : '/teacher-dashboard');
});

app.post('/post-event', (req, res) => {
  if (!req.session.user || req.session.user.role !== 'teacher') return res.redirect('/');
  const { title, description } = req.body;
  events.push({
    id: events.length + 1,
    title,
    description,
    date: new Date().toISOString().split('T')[0]
  });
  res.redirect(req.session.user.email === 'admin' ? '/admin' : '/teacher-dashboard');
});

app.post('/create-test', (req, res) => {
  if (!req.session.user || req.session.user.role !== 'teacher') return res.redirect('/');
  const { title, questions } = req.body;
  let parsedQuestions = [];
  try { parsedQuestions = JSON.parse(questions || '[]'); } catch (e) {}
  
  tests.push({
    id: tests.length + 1,
    title,
    questions: parsedQuestions,
    createdBy: req.session.user.name
  });
  res.redirect(req.session.user.email === 'admin' ? '/admin' : '/teacher-dashboard');
});

app.get('/verify/:id', (req, res) => {
  const badge = badges.find(b => b.id == req.params.id);
  if (!badge) return res.send('Invalid badge');
  res.render('verify', { badge });
});

app.listen(PORT, () => {
  console.log(`Credity running on port ${PORT}`);
});