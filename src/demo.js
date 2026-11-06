// A small dbt project (the classic jaffle shop, with owners, a contract and exposures),
// so a fresh install can be tried in one click and the connector demo has a repository.
export const SAMPLE_PROJECT = {
  'dbt_project.yml': `name: jaffle_shop
version: "1.0.0"
profile: jaffle_shop
model-paths: ["models"]
`,
  'models/staging/_sources.yml': `version: 2
sources:
  - name: raw
    description: Tables loaded every hour from the shop database.
    meta:
      owner: Data platform
    tables:
      - name: customers
        columns: [{ name: id }, { name: first_name }, { name: last_name }, { name: email }]
      - name: orders
        columns: [{ name: id }, { name: user_id }, { name: order_date }, { name: status }]
      - name: payments
        columns: [{ name: id }, { name: order_id }, { name: payment_method }, { name: amount }]
`,
  'models/staging/_staging.yml': `version: 2
models:
  - name: stg_customers
    description: One row per customer, cleaned from raw.customers.
    meta: { owner: Data platform }
    columns: [{ name: customer_id }, { name: first_name }, { name: last_name }, { name: email }]
  - name: stg_orders
    description: One row per order, cleaned from raw.orders.
    meta: { owner: Data platform }
    columns: [{ name: order_id }, { name: customer_id }, { name: order_date }, { name: status }]
  - name: stg_payments
    description: One row per payment. Amounts are converted from cents.
    meta: { owner: Data platform }
    columns: [{ name: payment_id }, { name: order_id }, { name: payment_method }, { name: amount }]
`,
  'models/staging/stg_customers.sql': `select
    id as customer_id,
    first_name,
    last_name,
    email
from {{ source('raw', 'customers') }}
`,
  'models/staging/stg_orders.sql': `select
    id as order_id,
    user_id as customer_id,
    order_date,
    status
from {{ source('raw', 'orders') }}
`,
  'models/staging/stg_payments.sql': `select
    id as payment_id,
    order_id,
    payment_method,
    amount / 100 as amount
from {{ source('raw', 'payments') }}
`,
  'models/marts/_marts.yml': `version: 2
groups:
  - name: finance
    owner: { name: Finance analytics, email: finance-analytics@example.com }
models:
  - name: orders
    description: One row per order with its payment totals. Public model read by finance and ML.
    group: finance
    access: public
    config:
      contract: { enforced: true }
    columns:
      - { name: order_id, data_type: integer }
      - { name: customer_id, data_type: integer }
      - { name: order_date, data_type: date }
      - { name: status, data_type: varchar }
      - { name: discount_amount, data_type: numeric }
      - { name: amount, data_type: numeric }
  - name: customers
    description: One row per customer with first and latest order and lifetime value.
    meta: { owner: Growth analytics }
    columns:
      - { name: customer_id }
      - { name: first_name }
      - { name: last_name }
      - { name: first_order }
      - { name: most_recent_order }
      - { name: number_of_orders }
      - { name: lifetime_value }
  - name: fct_revenue
    description: Daily revenue and discounts for completed orders.
    group: finance
    columns: [{ name: order_date }, { name: revenue }, { name: discounts }, { name: completed_orders }]
`,
  'models/marts/orders.sql': `with orders as (
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
`,
  'models/marts/customers.sql': `with customers as (
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
`,
  'models/marts/fct_revenue.sql': `select
    order_date,
    sum(amount) as revenue,
    sum(discount_amount) as discounts,
    count(*) as completed_orders
from {{ ref('orders') }}
where status = 'completed'
group by order_date
`,
  'models/exposures.yml': `version: 2
exposures:
  - name: revenue_dashboard
    label: Revenue dashboard
    type: dashboard
    url: https://example.com/dashboards/revenue
    description: Daily revenue and discounts reviewed in the Monday business review.
    owner: { name: Finance analytics, email: finance-analytics@example.com }
    depends_on: ["ref('fct_revenue')"]
  - name: churn_model
    label: Churn prediction model
    type: ml
    description: Weekly retrained model that scores customers for retention campaigns.
    owner: { name: ML platform, email: ml-platform@example.com }
    depends_on: ["ref('customers')", "ref('orders')"]
  - name: finance_close_export
    label: Monthly finance close export
    type: application
    description: Order totals exported to the ERP at month end.
    owner: { name: Finance operations, email: finops@example.com }
    depends_on: ["ref('orders')"]
`,
};

// The work item the demo is built around.
export const DEMO_ISSUE = {
  summary: 'Clean up the orders model',
  description: 'Drop discount_amount (nobody uses coupons any more) and rename amount to gross_amount.',
};

export const sampleFiles = (baseUrl = '') =>
  Object.entries(SAMPLE_PROJECT).map(([path, text]) => ({ path, text, url: baseUrl ? `${baseUrl}/${path}` : '' }));
