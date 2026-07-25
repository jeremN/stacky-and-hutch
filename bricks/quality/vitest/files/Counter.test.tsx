import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Counter } from './Counter'

describe('Counter.tsx', () => {
  it('increments the count on click', () => {
    render(<Counter />)
    const button = screen.getByRole('button')
    expect(button).toHaveTextContent('count is 0')
    fireEvent.click(button)
    expect(button).toHaveTextContent('count is 1')
  })
})
