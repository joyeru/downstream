with orders as (
    select * from {{ ref('stg_orders') }}
),

payments as (
    select * from {{ ref('stg_payments') }}
),

order_payments as (
    select
        order_id,
        sum(case when payment_method = 'coupon' then amount else 0 end) as discount_amount,
        sum(amount) as amount
    from payments
    group by order_id
)

select
    orders.order_id,
    orders.customer_id,
    orders.order_date,
    orders.status,
    order_payments.discount_amount,
    order_payments.amount
from orders
left join order_payments using (order_id)
