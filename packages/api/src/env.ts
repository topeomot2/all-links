/** An environment variable the Lambda cannot run without. */
export function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set — this Lambda cannot run without it`);

  return value;
}
