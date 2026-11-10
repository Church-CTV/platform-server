const bcrypt = require('bcryptjs');
const fs = require('fs-extra');
const path = require('path');

function hashPassword(plain) {
    return bcrypt.hashSync(plain, 12);
}

function verifyPassword(plain, hashed) {
    return bcrypt.compareSync(plain, hashed);
}

function loadPasswordHash() {
    const hashFile = path.join(__dirname, '..', '.admin_password_hash');
    if (fs.existsSync(hashFile)) {
        return fs.readFileSync(hashFile, 'utf8').trim();
    }
    if (process.env.ADMIN_PASSWORD) {
        const hash = hashPassword(process.env.ADMIN_PASSWORD);
        const tmpPath = hashFile + '.tmp';
        fs.writeFileSync(tmpPath, hash, 'utf8');
        fs.renameSync(tmpPath, hashFile);
        return hash;
    }
    return '';
}

function requireAuth(req, res, next) {
    if (req.session && req.session.adminAuthenticated) {
        return next();
    }
    if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
        return res.status(401).json({ error: 'Unauthorized. Please log in.' });
    }
    res.redirect('/admin/login');
}

module.exports = { hashPassword, verifyPassword, loadPasswordHash, requireAuth };
