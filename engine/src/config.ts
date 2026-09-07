import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const config = {
  databaseUrl: required("DATABASE_URL"),
  featureSetVersion: process.env.FEATURE_SET_VERSION ?? "v1",
  strategyVersion: process.env.STRATEGY_VERSION ?? "v1",
  modelVersion: process.env.MODEL_VERSION ?? "phase1-rule-engine-v1",
  instruments: (process.env.ENGINE_INSTRUMENTS ?? "NIFTY").split(","),
};
