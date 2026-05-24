const express = require('express');
const app = express();

// Tell Express to use EJS as the template engine
app.set('view engine', 'ejs');

// Serve the index.ejs file when someone visits the site
app.get('/', (req, res) => {
    res.render('index');
});

// Render provides a PORT environment variable, otherwise fallback to 3000
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Blue API Wallet is running on port ${PORT}`);
});
