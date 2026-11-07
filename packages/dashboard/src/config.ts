/**
 * Runtime config, written next to the shell by the stack's deployment
 * (`/app/config.json`, `no-store`). Kept out of the build so one build serves
 * any stage. Locally, copy the stack outputs into `public/config.json`.
 */
export interface DashboardConfig {
  region: string;
  userPoolId: string;
  userPoolClientId: string;
}

export async function loadConfig(): Promise<DashboardConfig> {
  const res = await fetch(`${import.meta.env.BASE_URL}config.json`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`config.json answered ${res.status}`);

  const config = (await res.json()) as Partial<DashboardConfig>;
  if (!config.region || !config.userPoolId || !config.userPoolClientId) {
    throw new Error('config.json is missing region, userPoolId or userPoolClientId');
  }
  return config as DashboardConfig;
}
