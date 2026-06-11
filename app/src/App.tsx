import { useState } from 'react'
import { Header } from './components/Header'
import { Explore } from './pages/Explore'
import { LaunchDetail } from './pages/LaunchDetail'
import { Create } from './pages/Create'
import { LAUNCHES } from './data/launches'

export type Route = { page: 'explore' } | { page: 'create' } | { page: 'launch'; id: number }

export default function App() {
  const [route, setRoute] = useState<Route>({ page: 'explore' })

  return (
    <div className="mx-auto min-h-screen max-w-6xl px-4 pb-24 sm:px-6">
      <Header route={route} onNavigate={setRoute} />
      {route.page === 'explore' && <Explore onOpen={(id) => setRoute({ page: 'launch', id })} onCreate={() => setRoute({ page: 'create' })} />}
      {route.page === 'create' && <Create onBack={() => setRoute({ page: 'explore' })} />}
      {route.page === 'launch' && (
        <LaunchDetail
          launch={LAUNCHES.find((l) => l.id === route.id) ?? LAUNCHES[0]}
          onBack={() => setRoute({ page: 'explore' })}
        />
      )}
    </div>
  )
}
