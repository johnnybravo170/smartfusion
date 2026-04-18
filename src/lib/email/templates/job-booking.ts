export function bookingEmailHtml({
  customerName,
  businessName,
  date,
  time,
  address,
}: {
  customerName: string;
  businessName: string;
  date: string;
  time: string;
  address?: string;
}): string {
  const addressLine = address ? `<p>Location: ${address}</p>` : '';

  return `<!DOCTYPE html>
<html>
<body style="font-family: system-ui, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h2 style="color: #0a0a0a;">Appointment confirmed</h2>
  <p>Hi ${customerName.split(' ')[0]},</p>
  <p><strong>${businessName}</strong> has booked your appointment for <strong>${date}</strong> at <strong>${time}</strong>.</p>
  ${addressLine}
  <p>We'll see you then!</p>
  <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;" />
  <p style="color: #999; font-size: 12px;">Sent via HeyHenry</p>
</body>
</html>`;
}

export function cancellationEmailHtml({
  customerName,
  businessName,
  date,
  time,
}: {
  customerName: string;
  businessName: string;
  date: string;
  time: string;
}): string {
  return `<!DOCTYPE html>
<html>
<body style="font-family: system-ui, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h2 style="color: #0a0a0a;">Appointment cancelled</h2>
  <p>Hi ${customerName.split(' ')[0]},</p>
  <p>Your appointment with <strong>${businessName}</strong> on <strong>${date}</strong> at <strong>${time}</strong> has been cancelled.</p>
  <p>If you have any questions, please reach out directly.</p>
  <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;" />
  <p style="color: #999; font-size: 12px;">Sent via HeyHenry</p>
</body>
</html>`;
}
