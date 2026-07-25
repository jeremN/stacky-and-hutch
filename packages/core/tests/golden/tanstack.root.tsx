// >>> stacky:app-head
// <<< stacky:app-head
import {
  Outlet,
  createRootRouteWithContext,
  HeadContent,
  Scripts,
} from '@tanstack/react-router'
import type { ReactNode } from 'react'
// >>> stacky:root-imports
// <<< stacky:root-imports

type RouterContext = object & {
  // >>> stacky:root-context
  // <<< stacky:root-context
}

export const Route = createRootRouteWithContext<RouterContext>()({
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
{/* <<< stacky:app-shell */}
        </header>
        {children}
        <Scripts />
      </body>
    </html>
  )
}
