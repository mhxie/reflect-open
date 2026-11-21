import { expect, it } from 'vitest'
import { render } from 'vitest-browser-react'
import { usePreviewOverflow } from './use-preview-overflow.ts'

function Preview({ loaded, lines }: { loaded: boolean; lines: number }) {
  const { setRoot, overflowing } = usePreviewOverflow()
  return (
    <div
      ref={setRoot}
      data-testid="preview"
      data-overflowing={overflowing}
      style={{ height: 48, overflow: 'hidden' }}
    >
      {loaded ? (
        <div>
          {Array.from({ length: lines }, (_, i) => (
            <p key={i} style={{ margin: 0, lineHeight: '20px' }}>
              Source paragraph {i}
            </p>
          ))}
        </div>
      ) : (
        <p style={{ margin: 0 }}>Loading</p>
      )}
    </div>
  )
}

it('follows loaded content when it replaces the loading block inside a fixed preview', async () => {
  const view = await render(<Preview loaded={false} lines={1} />)
  const preview = view.getByTestId('preview')
  await expect.element(preview).toHaveAttribute('data-overflowing', 'false')
  await view.rerender(<Preview loaded lines={1} />)
  await expect.element(preview).toHaveAttribute('data-overflowing', 'false')
  await view.rerender(<Preview loaded lines={4} />)
  await expect.element(preview).toHaveAttribute('data-overflowing', 'true')
  await view.rerender(<Preview loaded lines={1} />)
  await expect.element(preview).toHaveAttribute('data-overflowing', 'false')
  await view.unmount()
})
