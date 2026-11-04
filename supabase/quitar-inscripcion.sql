-- Permite que un administrador quite una inscripción de una tarea:
--   * la suya propia, en cualquier momento (aunque ya esté confirmada), o
--   * la de cualquier persona que NO sea administradora.
-- Igual que cancel_slot, si hay lista de espera entra la primera persona.

create or replace function public.quitar_inscripcion(p_task_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare t record; v_slots jsonb; v_waitlist jsonb; promovido text; libre int;
        estaba boolean; es_uno_mismo boolean; nombre text;
begin
  if not public.is_admin() then
    raise exception 'Solo un administrador puede quitar inscripciones';
  end if;

  es_uno_mismo := p_user_id = auth.uid();
  if not es_uno_mismo and exists (select 1 from public.profiles where id = p_user_id and role = 'admin') then
    raise exception 'No puedes quitar la inscripción de otro administrador';
  end if;

  select * into t from public.event_tasks where id = p_task_id for update;
  if not found then raise exception 'Tarea no encontrada'; end if;

  estaba := exists (select 1 from jsonb_array_elements(t.slots) s where (s->>'userId') = p_user_id::text);
  if not estaba then raise exception 'Esa persona no está inscrita en esta tarea'; end if;

  select coalesce(jsonb_agg(case when (s->>'userId') = p_user_id::text
           then jsonb_build_object('userId', null, 'claimedAt', null) else s end), '[]'::jsonb)
    into v_slots from jsonb_array_elements(t.slots) s;

  v_waitlist := coalesce(t.waitlist, '[]'::jsonb);
  promovido := v_waitlist->>0;
  if promovido is not null then
    select min(ord) into libre from jsonb_array_elements(v_slots) with ordinality as x(s, ord)
      where (x.s->>'userId') is null;
    if libre is not null then
      v_slots := jsonb_set(v_slots, array[(libre - 1)::text],
                   jsonb_build_object('userId', promovido, 'claimedAt', to_jsonb(now())));
      v_waitlist := v_waitlist - 0;
    else promovido := null; end if;
  end if;

  update public.event_tasks set slots = v_slots, waitlist = v_waitlist where id = p_task_id;

  if es_uno_mismo then
    insert into public.history_log (user_id, action, detail, type)
      values (auth.uid(), 'canceló su inscripción en', t.name, 'Tarea');
  else
    select name into nombre from public.profiles where id = p_user_id;
    insert into public.history_log (user_id, action, detail, type)
      values (auth.uid(), 'quitó la inscripción de ' || coalesce(nombre, 'un colaborador') || ' en', t.name, 'Tarea');
    insert into public.notifications (title, detail, audience_all, audience_users, link)
      values ('Te quitaron de una tarea',
              'Un administrador quitó tu inscripción en ' || t.name,
              false, jsonb_build_array(p_user_id::text), '/eventos/' || t.event_id);
  end if;

  if promovido is not null then
    insert into public.notifications (title, detail, audience_all, audience_users, link)
      values ('Entraste desde la lista de espera',
              'Se liberó un lugar en ' || t.name || ' y ahora formas parte del equipo',
              false, jsonb_build_array(promovido), '/eventos/' || t.event_id);
  end if;
end;
$function$;

revoke all on function public.quitar_inscripcion(uuid, uuid) from public, anon;
grant execute on function public.quitar_inscripcion(uuid, uuid) to authenticated;
