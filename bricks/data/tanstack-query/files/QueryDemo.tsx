import { useQuery } from '@tanstack/react-query'

export function QueryDemo() {
  const query = useQuery({ queryKey: ['demo'], queryFn: async () => 'ok' })
  return <p>{query.isSuccess ? query.data : 'loading…'}</p>
}
