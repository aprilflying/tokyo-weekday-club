import { readCounts } from '../lib/sheet.js';
export async function GET() {
  try { return Response.json(await readCounts(), {headers:{'Cache-Control':'no-store'}}); }
  catch { return Response.json({ok:false,error:'Availability is temporarily unavailable. Please try again.'},{status:503,headers:{'Cache-Control':'no-store'}}); }
}
