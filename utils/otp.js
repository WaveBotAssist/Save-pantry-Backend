// utils/otp.js
const bcrypt = require('bcrypt');

exports.genCode = () => String(Math.floor(100000 + Math.random() * 900000)); // 6 chiffres
exports.hash = (v) => bcrypt.hash(v, 10);
exports.compare = (v, h) => bcrypt.compare(v, h);
