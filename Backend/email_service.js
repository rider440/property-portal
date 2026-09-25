const nodemailer = require('nodemailer');
const { escapeHtml } = require('./auth');

async function sendDataRequestNotification(requestData, settings = {}) {
  const host = settings.smtp_host || process.env.SMTP_HOST || '';
  const port = parseInt(settings.smtp_port || process.env.SMTP_PORT || '587', 10);
  const user = settings.smtp_user || process.env.SMTP_USER || '';
  const pass = settings.smtp_pass || process.env.SMTP_PASS || '';
  const toEmail = settings.notify_email || process.env.NOTIFY_EMAIL || user;

  if (!host || !user || !pass) {
    console.log('[Email] SMTP credentials not configured yet. Skipping email send. (You can configure SMTP in Admin Settings)');
    return { success: false, reason: 'SMTP not configured' };
  }

  try {
    const transporter = nodemailer.createTransport({
      host: host,
      port: port,
      secure: port === 465,
      auth: {
        user: user,
        pass: pass
      }
    });

    const safeState = escapeHtml(requestData.state_name || 'Uttar Pradesh');
    const safeDistrict = escapeHtml(requestData.district_name || '');
    const safeTehsil = escapeHtml(requestData.tehsil_name || '--');
    const safeVillage = escapeHtml(requestData.village_name || '');
    const safeVillageCode = escapeHtml(requestData.village_code || '--');
    const safeUserName = escapeHtml(requestData.user_name || 'नागरिक');
    const safeMobile = escapeHtml(requestData.user_mobile || '');
    const safeNotes = escapeHtml(requestData.notes || 'कोई नहीं');

    const htmlContent = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden;">
        <div style="background: #1e3a8a; color: white; padding: 16px 20px; text-align: center;">
          <h2 style="margin: 0; font-size: 1.3rem;">📬 नया ग्राम डेटा अनुरोध (New Village Data Request)</h2>
          <p style="margin: 4px 0 0; font-size: 0.85rem; opacity: 0.9;">Gram Panchayat Property Portal</p>
        </div>
        
        <div style="padding: 20px; background: #ffffff; color: #1e293b;">
          <p style="font-size: 1rem; font-weight: bold; margin-bottom: 15px; color: #2563eb;">
            पोर्टल पर एक नया ग्राम डेटा जोड़ने का अनुरोध प्राप्त हुआ है:
          </p>

          <table style="width: 100%; border-collapse: collapse; font-size: 0.9rem;">
            <tr style="border-bottom: 1px solid #f1f5f9;">
              <td style="padding: 8px; font-weight: bold; color: #475569; width: 40%;">राज्य (State):</td>
              <td style="padding: 8px; color: #0f172a;">${safeState}</td>
            </tr>
            <tr style="border-bottom: 1px solid #f1f5f9;">
              <td style="padding: 8px; font-weight: bold; color: #475569;">जनपद (District):</td>
              <td style="padding: 8px; font-weight: bold; color: #0f172a;">${safeDistrict}</td>
            </tr>
            <tr style="border-bottom: 1px solid #f1f5f9;">
              <td style="padding: 8px; font-weight: bold; color: #475569;">तहसील (Tehsil):</td>
              <td style="padding: 8px; color: #0f172a;">${safeTehsil}</td>
            </tr>
            <tr style="border-bottom: 1px solid #f1f5f9;">
              <td style="padding: 8px; font-weight: bold; color: #475569;">ग्राम का नाम (Village):</td>
              <td style="padding: 8px; font-weight: bold; color: #15803d; font-size: 1.05rem;">${safeVillage}</td>
            </tr>
            <tr style="border-bottom: 1px solid #f1f5f9;">
              <td style="padding: 8px; font-weight: bold; color: #475569;">ग्राम कोड (Village Code):</td>
              <td style="padding: 8px; font-weight: bold; color: #d97706; font-family: monospace;">${safeVillageCode}</td>
            </tr>
            <tr style="border-bottom: 1px solid #f1f5f9;">
              <td style="padding: 8px; font-weight: bold; color: #475569;">अनुरोधकर्ता का नाम:</td>
              <td style="padding: 8px; color: #0f172a;">${safeUserName}</td>
            </tr>
            <tr style="border-bottom: 1px solid #f1f5f9;">
              <td style="padding: 8px; font-weight: bold; color: #475569;">मोबाइल नंबर:</td>
              <td style="padding: 8px; font-weight: bold; color: #2563eb;"><a href="tel:${safeMobile}" style="color: #2563eb; text-decoration: none;">${safeMobile}</a></td>
            </tr>
            <tr>
              <td style="padding: 8px; font-weight: bold; color: #475569;">अतिरिक्त टिप्पणी:</td>
              <td style="padding: 8px; color: #64748b;">${safeNotes}</td>
            </tr>
          </table>

          <div style="margin-top: 20px; padding: 12px; background: #f8fafc; border-radius: 6px; font-size: 0.8rem; color: #64748b; text-align: center;">
            दिनांक व समय: ${new Date().toLocaleString('hi-IN')}
          </div>
        </div>
      </div>
    `;

    const info = await transporter.sendMail({
      from: `"Gram Panchayat Portal" <${user}>`,
      to: toEmail,
      subject: `📬 नया ग्राम डेटा अनुरोध: ${requestData.village_name} (${requestData.district_name}) [कोड: ${requestData.village_code || 'N/A'}]`,
      text: `नया ग्राम अनुरोध:\nग्राम: ${requestData.village_name}\nग्राम कोड: ${requestData.village_code}\nतहसील: ${requestData.tehsil_name}\nजनपद: ${requestData.district_name}\nमोबाइल: ${requestData.user_mobile}`,
      html: htmlContent
    });

    console.log('[Email] Notification sent successfully! MessageId:', info.messageId);
    return { success: true, messageId: info.messageId };
  } catch (err) {
    console.error('[Email] Failed to send email notification:', err.message);
    return { success: false, error: err.message };
  }
}
module.exports = { sendDataRequestNotification };

