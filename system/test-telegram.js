// Quick test the assistant runs after the user connects Telegram.
// Sends one friendly message to their phone so they SEE it working.

const { sendTelegram } = require('./lib/telegram');

(async () => {
  const ok = await sendTelegram(
    "🎉 You're connected! This is your business assistant. You'll get a message here every time you make a sale."
  );
  if (ok) {
    console.log('SUCCESS: Test message sent. Ask the user to check their phone. ✅');
  } else {
    console.log('NOT SENT: Telegram is not connected yet, or the token/chat id is off. Re-check the two values in .env.');
    process.exitCode = 1;
  }
})();
