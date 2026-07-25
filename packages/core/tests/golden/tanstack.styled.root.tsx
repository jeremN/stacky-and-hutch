// >>> stacky:app-head
import '../app.css'
import { Icon } from '@iconify/react'
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
<Icon icon="ph:heart" />
{/* <<< stacky:app-shell */}
      </header>
      <Outlet />
    </>
  )
}
