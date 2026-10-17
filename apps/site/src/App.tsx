import { useEffect } from 'react';
import { MotionConfig } from 'framer-motion';
import { Footer } from './components/Footer';
import { Nav } from './components/Nav';
import { Changelog } from './pages/Changelog';
import { Docs } from './pages/Docs';
import { Download } from './pages/Download';
import { Home } from './pages/Home';
import { Login } from './pages/Login';
import { NotFound } from './pages/NotFound';
import { Pricing } from './pages/Pricing';
import { Router, useRoute } from './router';
import { META } from './site';

const PAGES: Record<string, () => React.ReactElement> = {
  '/': Home,
  '/download': Download,
  '/pricing': Pricing,
  '/docs': Docs,
  '/changelog': Changelog,
  '/login': Login,
};

function Page() {
  const { path } = useRoute();
  const normalized = path.length > 1 ? path.replace(/\/$/, '') : path;
  const Component = PAGES[normalized] ?? NotFound;
  useEffect(() => {
    document.title = (META[normalized] ?? META['/404']!).title;
  }, [normalized]);
  return <Component />;
}

export function App({ path }: { path: string }) {
  return (
    <MotionConfig reducedMotion="user">
      <Router initialPath={path}>
        <div className="relative min-h-screen overflow-x-clip">
          <Nav />
          <main>
            <Page />
          </main>
          <Footer />
        </div>
      </Router>
    </MotionConfig>
  );
}
