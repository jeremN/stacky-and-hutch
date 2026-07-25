// >>> stacky:app-head
import '../app.css'
import { Icon } from '@iconify/react'
// <<< stacky:app-head
import {
  Outlet,
  createRootRoute,
  HeadContent,
  Scripts,
} from '@tanstack/react-router'
import type { ReactNode } from 'react'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'stacky' },
    ],
  }),
  component: RootComponent,
})

function RootComponent() {
  return (
    <RootDocument>
      <Outlet />
    </RootDocument>
  )
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html>
      <head>
        <HeadContent />
      </head>
      <body>
        <header>
{/* >>> stacky:app-shell */}
<Icon icon="ph:heart" />
{/* <<< stacky:app-shell */}
        </header>
        {children}
        <Scripts />
      </body>
    </html>
  )
}
