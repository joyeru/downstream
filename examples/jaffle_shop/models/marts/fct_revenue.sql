select
    order_date,
    sum(amount) as revenue,
    sum(discount_amount) as discounts,
    count(*) as completed_orders
from {{ ref('orders') }}
where status = 'completed'
group by order_date
