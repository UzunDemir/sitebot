/**
 * Server-side environment access.
 *
 * Everything is read lazily inside functions so that `next build`
 * does not require environment variables at build time.
 */

export type AppEnv = {
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  deepseekApiKey: string;
  googleApiKey: string;
  embeddingProvider: 'google';
};

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. ` +
        'Copy .env.example to .env.local and fill it in.',
    );
  }
  return value;
}

/** First present value among candidate names (handles Supabase's new key naming). */
function firstOf(...names: string[]): string {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  throw new Error(
    `Missing required environment variable: ${names.join(' or ')}. ` +
      'Copy .env.example to .env.local and fill it in.',
  );
}

export function env(): AppEnv {
  return {
    supabaseUrl: required('SUPABASE_URL'),
    supabaseServiceRoleKey: firstOf('SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY'),
    deepseekApiKey: required('DEEPSEEK_API_KEY'),
    googleApiKey: required('GOOGLE_GENERATIVE_AI_API_KEY'),
    embeddingProvider: 'google',
  };
}
