const jwt = require('jsonwebtoken');
const secret = 'cb381187-2cda-4514-ac95-1fcfce539dde';
const ref = 'ewqtqmckhkievpgiufeg';
const iat = Math.floor(Date.now() / 1000);
const exp = iat + (10 * 365 * 24 * 60 * 60);

const servicePayload = { iss: 'supabase', ref, role: 'service_role', iat, exp };
const anonPayload = { iss: 'supabase', ref, role: 'anon', iat, exp };

console.log('---SERVICE_ROLE---');
console.log(jwt.sign(servicePayload, secret));
console.log('---ANON_KEY---');
console.log(jwt.sign(anonPayload, secret));
