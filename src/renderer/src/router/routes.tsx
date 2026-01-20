import { Navigate } from 'react-router-dom'
import { lazy, Suspense } from 'react'
import Loading from '../components/Loading'

const Home = lazy(() => import('../page/Home'))

const routes = [
  {
    path: '/home',
    element: (
      <Suspense fallback={<Loading />}>
        <Home />
      </Suspense>
    )
  },
  {
    path: '/',
    children: [
      {
        path: '',
        element: <Navigate to="home" />
      },
      {
        path: '*',
        element: <Navigate to="/" />
      }
    ]
  }
]
export default routes
