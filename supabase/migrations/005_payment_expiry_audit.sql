begin;

create or replace function public.expire_payment_assignments() returns integer
language plpgsql security definer set search_path=public as $$
declare
  expired_record record;
  expired_count integer := 0;
begin
  for expired_record in
    update payment_assignments
    set status='expired',updated_at=now()
    where status='active' and expires_at<=now()
    returning id,order_id,payment_id,expires_at
  loop
    update payments set status='payment_details_expired',updated_at=now()
    where id=expired_record.payment_id;

    update orders
    set status='payment_details_expired',
        payment_status='payment_details_expired',
        updated_at=now()
    where id=expired_record.order_id;

    insert into audit_logs(action,entity_type,entity_id,metadata)
    values(
      'payment_details.expired',
      'payment_assignment',
      expired_record.id,
      jsonb_build_object(
        'orderId',expired_record.order_id,
        'paymentId',expired_record.payment_id,
        'expiredAt',expired_record.expires_at
      )
    );
    expired_count := expired_count + 1;
  end loop;
  return expired_count;
end $$;

commit;
