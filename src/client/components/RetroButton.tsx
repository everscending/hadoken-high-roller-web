interface RetroButtonProps {
  onClick: () => void | Promise<void>
  children: React.ReactNode
  type?: 'button' | 'submit' | 'reset'
  disabled?: boolean
  className?: string
  onMouseDown?: (e: React.MouseEvent<HTMLButtonElement>) => void
}

const RetroButton = ({
  onClick,
  children,
  type = 'button',
  disabled = false,
  className = '',
  onMouseDown
}: RetroButtonProps): React.ReactElement => {
  const classes = ['btn-retro', className].filter(Boolean).join(' ')
  return (
    <button
      onClick={onClick}
      className={classes}
      type={type}
      disabled={disabled}
      onMouseDown={onMouseDown}
    >
      {children}
    </button>
  )
}

export default RetroButton
