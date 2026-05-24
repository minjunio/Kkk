const express = require('express');
const app = express();

app.set('view engine', 'ejs');
// This allows Express to read the data from the login form
app.use(express.urlencoded({ extended: true })); 

// 1. Show the Login Page
app.get('/', (req, res) => {
    res.render('index', { error: null });
});

// 2. Handle the Login Request
app.post('/login', (req, res) => {
    const { username, password } = req.body;
    
    if (username === 'admin' && password === 'monterysasd') {
        res.redirect('/wallet');
    } else {
        res.render('index', { error: 'Invalid username or password' });
    }
});

// 3. Show the Wallet Page (only after login)
app.get('/wallet', (req, res) => {
    res.render('wallet');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Blue API running on port ${PORT}`);
});
