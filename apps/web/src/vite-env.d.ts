/// <reference types="vite/client" />

// Only client-safe vars are declared here. Vite inlines every VITE_* value into
// the browser bundle, so this list must never grow to include a secret.
interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_ANON_KEY: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
