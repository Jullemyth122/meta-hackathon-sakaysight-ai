/**
 * Catches a crash inside the 3D canvas (most often: the browser can give us
 * neither WebGPU nor WebGL2, e.g. hardware acceleration is off) and says so,
 * instead of leaving an empty box. The panels keep working either way.
 */

import { Component, type ReactNode } from 'react';
import { useApp } from '@/app/store';

interface State {
  error: Error | null;
}

export class ViewportError extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  // Nothing will ever finish loading: no reason to keep this message behind the loading screen.
  override componentDidCatch() {
    useApp.getState().setStarted();
  }

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="viewport-error" role="alert">
        <h2>The 3D view could not start</h2>
        <p>
          This browser gave us neither WebGPU nor WebGL2. Turn on hardware acceleration (Chrome:
          Settings → System), update the browser, or try Chrome / Edge.
        </p>
        <p className="mono fine">{error.message}</p>
        <button type="button" className="btn" onClick={() => this.setState({ error: null })}>
          Try again
        </button>
      </div>
    );
  }
}
