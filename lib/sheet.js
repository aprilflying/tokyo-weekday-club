export async function sheetRequest(payload) {
  if (!process.env.SHEET_URL || !process.env.SHEET_TOKEN) throw new Error('Booking service unavailable');
  const response = await fetch(process.env.SHEET_URL, {
    method: 'POST', redirect: 'follow', signal: AbortSignal.timeout(20000),
    body: JSON.stringify({ token: process.env.SHEET_TOKEN, ...payload }),
  });
  if (!response.ok) throw new Error('Booking service unavailable');
  const data = await response.json();
  if (!data.ok) {
    const error = new Error(data.error || 'Booking could not be saved');
    error.code = data.code; error.full = data.full;
    throw error;
  }
  return data;
}
export async function readCounts() {
  if (!process.env.SHEET_URL) throw new Error('Booking service unavailable');
  const response = await fetch(`${process.env.SHEET_URL}?counts=1&fresh=1&_=${Date.now()}`, {
    redirect:'follow', signal:AbortSignal.timeout(15000), cache:'no-store',
  });
  const counts = await response.json();
  if (!response.ok || counts.bookingVersion !== 9 || !counts.sessions || !counts.confirmed) throw new Error('Booking service is updating. Please try again shortly.');
  return counts;
}
