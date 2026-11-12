import { randomUUID } from 'node:crypto'

export interface OrderItem {
  sku: string
  quantity: number
}

export interface Order {
  id: string
  items: OrderItem[]
  createdAt: string
}

/** In-memory orders, to replace with your database. */
export const createOrderStore = () => {
  const orders = new Map<string, Order>()

  return {
    get: async (id: string) => orders.get(id),
    create: async (items: OrderItem[]): Promise<Order> => {
      const order: Order = {
        id: randomUUID(),
        items,
        createdAt: new Date().toISOString(),
      }
      orders.set(order.id, order)
      return order
    },
  }
}

export type OrderStore = ReturnType<typeof createOrderStore>
