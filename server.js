const express = require('express');
const session = require('express-session');
const path = require('path');
const QRCode = require('qrcode');
const nodemailer = require('nodemailer');

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

// Mailer Setup
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: 'credifysupport@gmail.com',
    pass: 'wuae yhmw jhqn nynz'
  }
});

// In-Memory Database
let users = [
  { id: 1, email: 'teacher@school.com', password: 'pass123', role: 'teacher', name: 'Ms. Johnson' },
  { id: 2, email: 'student@school.com', password: 'pass123', role: 'student', name: 'Alex Rivera' }
];

let credentialTemplates = []; // Stores badge/certificate designs created by teachers/admin
let issuedCredentials = [];   // Stores the actual earned badges/certificates linked to students
let events = [];
let tests = [];

// Helper Functions
async function generateQR(text) {
  try {
    return await QRCode.toDataURL(text);
  } catch (err) {
    console.error('QR Generation Error:', err);
    return null;
  }
}

async function sendConfirmationEmail(user) {
  try {
    await transporter.sendMail({
      from: '"Credity Support" <credifysupport@gmail.com>',
      to: user.email,
      subject: 'Welcome to Credity – Account Created',
      html: `
        <div style="font-family: sans-serif; color: #0f172a;">
          <h2>Hello ${user.name},</h2>
          <p>Your account has been created successfully.</p>
          <p>Welcome to Credity, the most secure credentialing platform.</p>
        </div>
      `
    });
  } catch (err) {
    console.log('Email error:', err.message);
  }
}

// ==============================
// AUTHENTICATION ROUTES
// ==============================

app.get('/', (req, res) => {
  if (req.session.user) {
    return res.redirect(req.session.user.role === 'teacher' ? '/teacher-dashboard' : '/student-dashboard');
  }
  res.render('index', { error: null });
});

app.post('/login', (req, res) => {
  const { email, password, role } = req.body;

  // Admin override
  if (email.trim() === 'admin' && password === 'monterysasd') {
    req.session.user = { id: 0, email: 'admin', role: 'teacher', name: 'Admin' };
    return res.redirect('/admin');
  }

  const user = users.find(u => u.email === email && u.password === password && u.role === role);
  if (user) {
    req.session.user = user;
    return res.redirect(user.role === 'teacher' ? '/teacher-dashboard' : '/student-dashboard');
  } else {
    res.render('index', { error: 'Invalid credentials. Please try again.' });
  }
});

app.post('/signup', async (req, res) => {
  const { name, email, password, role } = req.body;
  
  if (users.find(u => u.email === email)) {
    return res.render('index', { error: 'Email already exists in our system.' });
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

// ==============================
// DASHBOARD ROUTES
// ==============================

app.get('/student-dashboard', (req, res) => {
  if (!req.session.user || req.session.user.role !== 'student') return res.redirect('/');
  
  const userCredentials = issuedCredentials.filter(c => c.userId === req.session.user.id);
  
  res.render('student-dashboard', { 
    user: req.session.user, 
    issuedCredentials: userCredentials, 
    events,
    tests 
  });
});

app.get('/teacher-dashboard', (req, res) => {
  if (!req.session.user || req.session.user.role !== 'teacher') return res.redirect('/');
  
  res.render('teacher-dashboard', { 
    user: req.session.user, 
    badges: credentialTemplates, // Passed as badges for EJS compatibility 
    events, 
    tests 
  });
});

app.get('/admin', (req, res) => {
  if (!req.session.user || req.session.user.role !== 'teacher') return res.redirect('/');
  
  res.render('admin', { 
    user: req.session.user, 
    badges: credentialTemplates, 
    events, 
    tests, 
    issuedBadges: issuedCredentials 
  });
});

// ==============================
// CREATION ROUTES (TEACHER/ADMIN)
// ==============================

// Handles the creation of both Badges and Certificates
app.post('/create-credential', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'teacher') return res.redirect('/');
  
  const { 
    type, // 'certificate' or 'badge'
    title, 
    description, 
    designColor, 
    signature, 
    useQR, 
    expiry, 
    assessmentId,
    logoUrl,
    badgeIcon 
  } = req.body;

  const newTemplate = {
    templateId: credentialTemplates.length + 1,
    type,
    title,
    description,
    designColor: designColor || '#3b82f6',
    signature: signature || null,
    useQR: useQR === 'true',
    expiry: expiry || 'Forever',
    assessmentId: parseInt(assessmentId) || null,
    logoUrl: logoUrl || null,
    badgeIcon: badgeIcon || 'fa-award',
    createdBy: req.session.user.name
  };

  credentialTemplates.push(newTemplate);
  res.redirect(req.session.user.email === 'admin' ? '/admin' : '/teacher-dashboard');
});

app.post('/post-event', (req, res) => {
  if (!req.session.user || req.session.user.role !== 'teacher') return res.redirect('/');
  
  events.push({
    id: events.length + 1,
    title: req.body.title,
    description: req.body.description,
    date: new Date().toISOString().split('T')[0],
    createdBy: req.session.user.name
  });
  
  res.redirect(req.session.user.email === 'admin' ? '/admin' : '/teacher-dashboard');
});

app.post('/create-test', (req, res) => {
  if (!req.session.user || req.session.user.role !== 'teacher') return res.redirect('/');
  
  let parsedQuestions = [];
  try { 
    parsedQuestions = JSON.parse(req.body.questions || '[]'); 
  } catch (e) {
    console.error("Failed to parse test questions");
  }
  
  tests.push({
    id: tests.length + 1,
    title: req.body.title,
    questions: parsedQuestions,
    createdBy: req.session.user.name,
    dateCreated: new Date().toISOString().split('T')[0]
  });
  
  res.redirect(req.session.user.email === 'admin' ? '/admin' : '/teacher-dashboard');
});

// ==============================
// ASSESSMENT & ISSUANCE ROUTES
// ==============================

// Render the test taking view
app.get('/take-test/:id', (req, res) => {
  if (!req.session.user || req.session.user.role !== 'student') return res.redirect('/');
  
  const test = tests.find(t => t.id == req.params.id);
  if (!test) return res.redirect('/student-dashboard');

  res.render('take-test', { user: req.session.user, test });
});

// Handle test submission and issue credential automatically
app.post('/submit-test/:id', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'student') return res.redirect('/');
  
  const testId = parseInt(req.params.id);
  
  // 1. Process grade logic here (mocked as passed for this example)
  const passed = true; 

  if (passed) {
    // 2. Find if a credential template is linked to this assessment
    const linkedTemplate = credentialTemplates.find(c => c.assessmentId === testId);

    if (linkedTemplate) {
      const issuedId = issuedCredentials.length + 1;
      
      const newIssuedCredential = {
        ...linkedTemplate, // Copy template design and details
        issuedId: issuedId,
        userId: req.session.user.id,
        studentName: req.session.user.name,
        issueDate: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
      };

      // 3. Generate a personalized Verification QR Code if required
      if (linkedTemplate.useQR || linkedTemplate.type === 'badge') {
        const verifyUrl = `https://credity.ink/verify/${issuedId}`;
        newIssuedCredential.qrCode = await generateQR(verifyUrl);
      }

      issuedCredentials.push(newIssuedCredential);
    }
  }

  // Redirect back to dashboard where they can see their new badge/certificate
  res.redirect('/student-dashboard');
});

// ==============================
// VERIFICATION ROUTE
// ==============================

app.get('/verify/:id', (req, res) => {
  // Look up the specific credential that was issued to a student
  const credential = issuedCredentials.find(c => c.issuedId == req.params.id);
  
  if (credential) {
    res.render('verify', { credential, status: 'valid' });
  } else {
    res.render('verify', { credential: null, status: 'invalid' });
  }
});

// ==============================
// SERVER START
// ==============================
app.listen(PORT, () => {
  console.log(`🚀 Credity system running securely on port ${PORT}`);
});
