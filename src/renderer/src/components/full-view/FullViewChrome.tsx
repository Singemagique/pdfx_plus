import { ChevronLeftIcon, ChevronRightIcon, CloseIcon } from '../icons'
import { isMac } from './geometry'

interface FullViewChromeProps {
  chromeOpacity: number
  docName: string
  pi: number
  pageCount: number
  runClose: () => void
  navByKey: (axis: 'x' | 'y', dir: 1 | -1) => void
}

export function FullViewChrome({
  chromeOpacity,
  docName,
  pi,
  pageCount,
  runClose,
  navByKey
}: FullViewChromeProps): React.JSX.Element {
  return (
    <div className="full-chrome" style={{ opacity: chromeOpacity }}>
      <header className={`full-bar${isMac ? ' mac' : ''}`}>
        <span className="full-title">{docName}</span>
        <button className="icon-btn" title="Close (Esc)" onClick={runClose}>
          <CloseIcon size={16} />
        </button>
      </header>

      <button
        className="full-nav prev"
        disabled={pi === 0}
        onClick={() => navByKey('x', -1)}
        title="Previous page (←)"
      >
        <ChevronLeftIcon size={18} />
      </button>
      <button
        className="full-nav next"
        disabled={pi === pageCount - 1}
        onClick={() => navByKey('x', 1)}
        title="Next page (→)"
      >
        <ChevronRightIcon size={18} />
      </button>

      <div className="full-count">
        {pi + 1} / {pageCount}
      </div>
    </div>
  )
}
