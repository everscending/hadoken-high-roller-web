import React, { Component, ErrorInfo, ReactNode } from 'react'
import { useLocation } from 'react-router-dom'

interface Props {
  children: ReactNode
  // Changes to this value reset the boundary (e.g. on route navigation),
  // so a transient error on one route does not permanently block the app.
  resetKey?: string
}

interface State {
  hasError: boolean
  error: Error | null
}

class ErrorBoundaryInner extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null
  }

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('ErrorBoundary caught an error:', error, errorInfo)
  }

  public componentDidUpdate(prevProps: Props): void {
    // When the reset key changes (e.g. the user navigated to a new route),
    // clear the error so the app shell can recover without a full reload.
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false, error: null })
    }
  }

  private handleRetry = (): void => {
    this.setState({ hasError: false, error: null })
  }

  public render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="error-boundary">
          <h1>Something went wrong</h1>
          <p>An unexpected error occurred in the application.</p>
          {import.meta.env.DEV && this.state.error && (
            <pre className="error-boundary__detail">{this.state.error.message}</pre>
          )}
          <div className="error-boundary__actions">
            <button onClick={this.handleRetry}>Try Again</button>
            <button
              onClick={() => {
                window.location.reload()
              }}
            >
              Reload Page
            </button>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}

function ErrorBoundary({ children }: { children: ReactNode }): JSX.Element {
  const location = useLocation()
  return <ErrorBoundaryInner resetKey={location.pathname}>{children}</ErrorBoundaryInner>
}

export default ErrorBoundary
