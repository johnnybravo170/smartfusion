import { type NextRequest, NextResponse } from 'next/server';

export async function GET(_req: NextRequest) {
  return NextResponse.json({
    ok: true,
    service: 'ops.heyhenry.io',
    time: new Date().toISOString(),
  });
}
