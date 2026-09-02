import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3100),
  PUBLIC_URL: z.string().url().default("https://billing.equiprofile.online"),
  DATABASE_URL: z.string().min(1),
  SESSION_SECRET: z.string().min(32),
  STRIPE_SECRET_KEY: z.string().min(1),
  STRIPE_WEBHOOK_SECRET: z.string().min(1),
  EQUIPROFILE_APP_ID: z.string().regex(/^[a-z0-9_-]{2,80}$/).default("equiprofile"),
  EQUIPROFILE_CORE_URL: z.string().url().default("https://equiprofile.online"),
  BILLING_CONNECTOR_KEY: z.string().min(32),
});

export type BillingConfig = z.infer<typeof schema> & Record<string, string | number>;

export function loadConfig(source: NodeJS.ProcessEnv = process.env): BillingConfig {
  const parsed = schema.parse(source) as BillingConfig;
  for (const key of ["PUBLIC_URL", "EQUIPROFILE_CORE_URL"] as const) {
    const url = new URL(String(parsed[key]));
    if (parsed.NODE_ENV === "production" && url.protocol !== "https:") {
      throw new Error(`${key} must use HTTPS in production`);
    }
  }
  return { ...source, ...parsed } as BillingConfig;
}
