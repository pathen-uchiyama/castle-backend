require('dotenv').config();
const { Resend } = require('resend');
const { createClient } = require('@supabase/supabase-js');

const resend = new Resend(process.env.RESEND_API_KEY);
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const MOCK_OTP = "112233";

async function testPipeline() {
  console.log("1. Finding a test account...");
  const { data: accounts } = await db.from('skipper_accounts')
    .select('email')
    .eq('status', 'UNREGISTERED')
    .limit(1);
    
  if (!accounts || accounts.length === 0) {
    console.error("No test accounts found.");
    return;
  }
  
  const testEmail = accounts[0].email;
  console.log(`Using test email: ${testEmail}`);
  
  console.log("2. Sending mock Disney email via Resend...");
  try {
    const { data: sendResult, error: sendError } = await resend.emails.send({
      from: 'DisneyTest <test@auth.castlecompanion.com>',
      to: testEmail,
      subject: 'Your one-time passcode for Walt Disney World',
      html: `<html><body><span id="otp_code">${MOCK_OTP}</span></body></html>`,
      text: `Your one-time passcode is ${MOCK_OTP}.`
    });
    
    if (sendError) {
      console.error("Failed to send email:", sendError);
      return;
    }
    console.log("Email sent! Delivery ID:", sendResult.id);
  } catch (e) {
    console.error("Error from resend:", e);
    return;
  }
  
  console.log("3. Waiting 10 seconds for Cloudflare and backend processing...");
  await new Promise(r => setTimeout(r, 10000));
  
  console.log("4. Checking Supabase for the OTP...");
  const { data: codes, error: dbError } = await db.from('verification_codes')
    .select('*')
    .eq('email', testEmail)
    .order('received_at', { ascending: false })
    .limit(1);
    
  if (dbError) {
    console.error("DB Error:", dbError);
    return;
  }
  
  if (codes && codes.length > 0) {
    if (codes[0].code === MOCK_OTP) {
      console.log(`✅ SUCCESS! OTP ${MOCK_OTP} successfully caught by Cloudflare and stored in DB.`);
    } else {
      console.log(`❌ FAILED. Found a different OTP: ${codes[0].code}`);
    }
  } else {
    console.log("❌ FAILED. No verification codes found in DB. Cloudflare worker may not have routed it.");
  }
}

testPipeline();
