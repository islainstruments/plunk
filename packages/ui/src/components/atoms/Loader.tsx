import Image from 'next/image';
import {useEffect, useState} from 'react';
import {useRouter} from 'next/router';
import {IconSpinner} from './IconSpinner';

export interface LoaderProps {
  message?: string;
  showLogo?: boolean;
}

export function Loader({message, showLogo = true}: LoaderProps) {
  const [showClearCache, setShowClearCache] = useState(false);
  const router = useRouter();

  useEffect(() => {
    const timer = setTimeout(() => setShowClearCache(true), 5000);
    return () => clearTimeout(timer);
  }, []);

  const handleClearCache = () => {
    if (process.env.NEXT_PUBLIC_ISLA_STAFF === 'true') {
      // This embedded app must not erase the parent website session.
      window.location.reload();
      return;
    }
    document.cookie.split(';').forEach(c => {
      document.cookie = c.replace(/^ +/, '').replace(/=.*/, '=;expires=' + new Date().toUTCString() + ';path=/');
    });
    localStorage.clear();
    sessionStorage.clear();
    void router.push('/auth/login');
  };

  return (
    <div className="h-screen flex items-center justify-center bg-white">
      <div className="flex flex-col items-center gap-6 animate-in fade-in duration-500">
        {showLogo && (
          <Image unoptimized src={`${router.basePath}/assets/logo.png`} alt="Plunk" width={40} height={40} className="rounded-lg" priority />
        )}

        <IconSpinner />

        {message && <p className="text-xs text-neutral-400">{message}</p>}

        {showClearCache && (
          <div className="animate-in fade-in slide-in-from-bottom-1 duration-500 text-center">
            <p className="text-xs text-neutral-400 mb-2">Taking too long?</p>
            <button
              onClick={handleClearCache}
              className="text-xs text-neutral-500 hover:text-neutral-800 underline underline-offset-2 transition-colors duration-150"
            >
              Clear cache and reload
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
