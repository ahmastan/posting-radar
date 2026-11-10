import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { pool } from "./db.js";
import { ensureUser } from "./store.js";
const cookieName = "posting_radar_guest";
function secret() {
  if (!process.env.SESSION_SECRET) throw new Error("SESSION_SECRET is required for anonymous session security.");
  return process.env.SESSION_SECRET;
}
export function signGuestId(id: string) { return `${id}.${createHmac("sha256", secret()).update(id).digest("base64url")}`; }
export function verifyGuestCookie(cookie: string): string | null {
  const [id, signature, extra] = cookie.split(".");
  if (!/^[a-f0-9-]{36}$/.test(id || "") || !signature || extra) return null;
  const expected = signGuestId(id).split(".")[1];
  const actual = Buffer.from(signature), comparison = Buffer.from(expected);
  return actual.length === comparison.length && timingSafeEqual(actual, comparison) ? id : null;
}
export async function guestOwner(req: Request): Promise<string | null> {
  const value = req.headers.cookie?.split(";").map(s => s.trim()).find(s => s.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
  const id = value ? verifyGuestCookie(value) : null;
  if (!id) return null;
  return (await pool.query("SELECT user_id FROM radar_guest_sessions WHERE id=$1 AND expires_at>now()", [id])).rows[0]?.user_id || null;
}
export async function createGuest(req: Request, res: Response): Promise<string> {
  const id = randomUUID(), userId = `guest:${id}`;
  await ensureUser(userId);
  await pool.query("INSERT INTO radar_guest_sessions(id,user_id) VALUES($1,$2)", [id, userId]);
  res.cookie(cookieName, signGuestId(id), {
    httpOnly: true, sameSite: "lax", secure: req.secure, maxAge: 30 * 24 * 60 * 60 * 1000, path: "/"
  });
  return userId;
}
