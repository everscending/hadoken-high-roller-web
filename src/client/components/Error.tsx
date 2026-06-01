interface ErrorProps {
  error: string
}

const Error = ({ error }: ErrorProps): React.ReactElement => {
  return <div className="error-message">{error}</div>
}

export default Error
