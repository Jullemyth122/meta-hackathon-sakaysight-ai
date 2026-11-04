/**
 * A small entry, so that the loading screen in index.html paints first: reading
 * the app's code holds the page up for seconds on a slow machine, and the
 * browser would start on that before showing anything.
 */
import './styles/main.scss';

const start = () => void import('./boot');
if (document.hidden) start();
else requestAnimationFrame(() => setTimeout(start));
