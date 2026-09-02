import type { NextFunction, Request, Response } from "express";
import type { Database } from "./db.js";
import { tokenHash } from "./security.js";

export type BillingUser = {
  id: string;
  application_id: string;
  external_user_id: string;
  email: string;
  display_name: string | null;
  external_role: string;
  stripe_customer_id: string | null;
  billing_organization_id: string | null;
};

declare global {
  namespace Express { interface Request { billingUser?: BillingUser } }
}

export function requireSession(db: Database) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const token = req.cookies?.ep_billing_session;
    if (!token) return res.status(401).json({ error: "Authentication required" });
    const result = await db.query(
      `SELECT u.*,s.organization_id AS billing_organization_id FROM billing_sessions s JOIN billing_users u ON u.id=s.user_id
       WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
      [tokenHash(token)],
    );
    if (!result.rows[0]) return res.status(401).json({ error: "Session expired" });
    req.billingUser = result.rows[0] as BillingUser;
    next();
  };
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (req.billingUser?.external_role !== "admin") return res.status(403).json({ error: "Administrator access required" });
  next();
}
