// >>> stacky:app-head
// <<< stacky:app-head
import { Outlet, createRootRoute } from '@tanstack/react-router'

export const Route = createRootRoute({
  component: RootComponent,
})

function RootComponent() {
  return (
    <>
      <header>
{/* >>> stacky:app-shell */}
{/* <<< stacky:app-shell */}
      </header>
      <Outlet />
    </>
  )
}
