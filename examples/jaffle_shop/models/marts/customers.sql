with customers as (
    select * from {{ ref('stg_customers') }}
),

orders as (
    select * from {{ ref('orders') }}
)

select
    customers.customer_id,
    customers.first_name,
    customers.last_name,
    min(orders.order_date) as first_order,
    max(orders.order_date) as most_recent_order,
    count(orders.order_id) as number_of_orders,
    sum(orders.amount) as lifetime_value
from customers
left join orders using (customer_id)
group by 1, 2, 3
