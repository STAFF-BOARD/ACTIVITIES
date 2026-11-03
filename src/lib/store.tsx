"use client";

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { supabase, isSupabaseConfigured } from "./supabase";
import {
  AppNotification,
  CalendarEntry,
  ChatMessage,
  EventTask,
  HistoryEntry,
  MonthNote,
  SchoolEvent,
  StaffUser,
  TaskExecStatus,
} from "./types";
import { dueLabel, isDueSoon, shouldArchive } from "./task-helpers";
import { CURSOS, Pizarra, PizarraFila } from "./types";
import { comprimirImagen } from "./imagenes";
import { avisarAlEquipo } from "./push";

interface InstitutionSettings {
  name: string;
  /** Calendario oficial del colegio (PDF, imagen o Excel) como referencia. */
  officialCalendarUrl?: string;
  officialCalendarName?: string;
  domain: string;
  schoolYear: string;
  timezone: string;
  cancelWindowMinutes: number;
  archiveAfterDays: number;
  requireEvidence: boolean;
  notifyDeadline: boolean;
}

const defaultSettings: InstitutionSettings = {
  name: "CARACOLI GLOBAL SCHOOL",
  domain: "colegio.edu.do",
  schoolYear: "2026-2027",
  timezone: "Santo Domingo (UTC-4)",
  cancelWindowMinutes: 1,
  archiveAfterDays: 30,
  requireEvidence: true,
  notifyDeadline: true,
};

/** Datos de acceso que Staff Board entrega al crear o restablecer una cuenta. */
export interface Credenciales {
  nombre: string;
  email: string;
  password: string;
}

interface StoredState {
  users: StaffUser[];
  events: SchoolEvent[];
  tasks: EventTask[];
  calendar: CalendarEntry[];
  monthNotes: MonthNote[];
  history: HistoryEntry[];
  pizarras: Pizarra[];
  notifications: AppNotification[];
  settings: InstitutionSettings;
  currentUserId: string;
  loggedIn: boolean;
  loading: boolean;
  /** Mensaje visible si faltan las variables de entorno de Supabase. */
  configError: string | null;
}

const emptyState: StoredState = {
  pizarras: [],
  users: [],
  events: [],
  tasks: [],
  calendar: [],
  monthNotes: [],
  history: [],
  notifications: [],
  settings: defaultSettings,
  currentUserId: "",
  loggedIn: false,
  loading: true,
  configError: isSupabaseConfigured
    ? null
    : "Falta conectar Supabase: define NEXT_PUBLIC_SUPABASE_URL y NEXT_PUBLIC_SUPABASE_ANON_KEY en .env.local (ver supabase/README).",
};

/* ============================================================
   MAPEO fila de la base de datos (snake_case) -> tipos de la app
   ============================================================ */
function mapProfile(r: any): StaffUser {
  return {
    id: r.id,
    name: r.name,
    email: r.email,
    role: r.role,
    title: r.title ?? undefined,
    area: r.area ?? undefined,
    status: r.status,
    initials: r.initials,
    color: r.color,
    joinedAt: r.joined_at,
  };
}
function mapEvent(r: any, taskIds: string[]): SchoolEvent {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    coverEmoji: r.cover_emoji,
    coverImage: r.cover_image ?? undefined,
    color: r.color,
    createdAt: r.created_date,
    eventDate: r.event_date,
    dueDate: r.due_date ?? undefined,
    status: r.status,
    createdBy: r.created_by,
    taskIds,
  };
}
function mapChat(r: any): ChatMessage {
  return {
    id: r.id,
    authorId: r.author_id ?? "",
    text: r.text,
    createdAt: r.created_at,
    reactions: r.reactions ?? {},
    attachments: r.attachments ?? [],
    recipientId: r.recipient_id ?? undefined,
  };
}
function mapTask(r: any, chat: ChatMessage[]): EventTask {
  return {
    id: r.id,
    eventId: r.event_id,
    name: r.name,
    description: r.description,
    color: r.color,
    priority: r.priority,
    status: r.status,
    dueDate: r.due_date,
    maxCollaborators: r.max_collaborators,
    referenceImage: r.reference_image ?? undefined,
    slots: r.slots ?? [],
    requiresLeader: r.requires_leader,
    leaderId: r.leader_id,
    chat,
    evidence: r.evidence ?? [],
    attachments: r.attachments ?? [],
    waitlist: r.waitlist ?? [],
    archived: r.archived,
    deadlineNotified: r.deadline_notified,
  };
}
function mapNotification(r: any, readIds: Set<string>): AppNotification {
  return {
    id: r.id,
    title: r.title,
    detail: r.detail,
    createdAt: r.created_at,
    read: readIds.has(r.id),
    audience: r.audience_all ? "all" : (r.audience_users ?? []),
    link: r.link ?? undefined,
  };
}
function mapMonthNote(r: any): MonthNote {
  return { month: r.month, content: r.content ?? "", updatedAt: r.updated_at, updatedBy: r.updated_by ?? undefined };
}

function mapCalendar(r: any): CalendarEntry {
  return { id: r.id, date: r.date, title: r.title, kind: r.kind, location: r.location ?? undefined, time: r.time ?? undefined, motto: r.motto ?? undefined, description: r.description ?? undefined, responsibles: r.responsibles ?? undefined, customKind: r.custom_kind ?? undefined, eventId: r.event_id ?? undefined };
}
function mapPizarraFila(r: any): PizarraFila {
  return {
    id: r.id,
    pizarraId: r.pizarra_id,
    curso: r.curso,
    orden: r.orden ?? 0,
    asignacion: r.asignacion ?? undefined,
    presupuesto: r.presupuesto ?? undefined,
    ayudante: r.ayudante ?? undefined,
    hecho: !!r.hecho,
    hechoPor: r.hecho_por ?? undefined,
    hechoAt: r.hecho_at ?? undefined,
  };
}
function mapPizarra(r: any, filas: any[]): Pizarra {
  return {
    id: r.id,
    title: r.title,
    date: r.date ?? undefined,
    session: r.session ?? undefined,
    notes: r.notes ?? undefined,
    status: r.status,
    createdBy: r.created_by ?? undefined,
    createdAt: r.created_at,
    filas: filas
      .filter((f) => f.pizarra_id === r.id)
      .map(mapPizarraFila)
      .sort((a, b) => a.orden - b.orden),
  };
}
function mapHistory(r: any): HistoryEntry {
  return { id: r.id, userId: r.user_id, action: r.action, detail: r.detail, type: r.type, createdAt: r.created_at };
}
function mapSettings(r: any): InstitutionSettings {
  return {
    name: r.name,
    officialCalendarUrl: r.official_calendar_url ?? undefined,
    officialCalendarName: r.official_calendar_name ?? undefined,
    domain: r.domain,
    schoolYear: r.school_year,
    timezone: r.timezone,
    cancelWindowMinutes: r.cancel_window_minutes,
    archiveAfterDays: r.archive_after_days,
    requireEvidence: r.require_evidence,
    notifyDeadline: r.notify_deadline,
  };
}

interface AppContextValue extends StoredState {
  currentUser: StaffUser;
  isAdmin: boolean;
  eventById: (id: string) => SchoolEvent | undefined;
  tasksForEvent: (eventId: string) => EventTask[];
  userById: (id: string) => StaffUser | undefined;
  canSeeEvent: (event: SchoolEvent) => boolean;
  visibleEvents: SchoolEvent[];
  wallEvents: SchoolEvent[];
  myEvents: SchoolEvent[];
  canEditEvent: (event: SchoolEvent) => boolean;
  canDeleteTask: (task: EventTask) => boolean;
  createEvent: (data: Partial<SchoolEvent> & { name: string }) => Promise<SchoolEvent | null>;
  updateEvent: (id: string, patch: Partial<SchoolEvent>) => Promise<void>;
  deleteEvent: (id: string) => Promise<void>;
  duplicateEvent: (id: string) => Promise<void>;
  createTask: (data: Partial<EventTask> & { eventId: string; name: string }) => Promise<EventTask | null>;
  updateTask: (id: string, patch: Partial<EventTask>) => Promise<void>;
  deleteTask: (id: string) => Promise<void>;
  claimSlot: (taskId: string, slotIndex: number) => Promise<string | void>;
  cancelSlot: (taskId: string) => Promise<string | void>;
  /** Renuncia al tiempo de espera: deja la inscripción firme al instante. */
  confirmSlot: (taskId: string) => Promise<string | void>;
  /** Solo administración: quita la inscripción propia o la de alguien que no sea administrador. */
  quitarInscripcion: (taskId: string, userId: string) => Promise<string | void>;
  joinWaitlist: (taskId: string) => Promise<string | void>;
  leaveWaitlist: (taskId: string) => Promise<string | void>;
  hasEvidence: (task: EventTask) => boolean;
  canFinishTask: (task: EventTask) => boolean;
  myNotifications: AppNotification[];
  liveTasks: EventTask[];
  runArchiveSweep: () => Promise<number>;
  runDeadlineAlerts: () => Promise<number>;
  /**
   * Envía un aviso.
   *  "all"    = todo el personal
   *  "admins" = solo los administradores
   *  array    = solo esas personas
   */
  notify: (
    title: string,
    detail: string,
    audience?: "all" | "admins" | string[],
    /** Si es true, además del aviso dentro de la app suena en el celular de todos.
        Reservado a lo que interesa a todo el colegio: eventos, calendario y mural. */
    alCelular?: { url?: string } | false,
    /** A dónde lleva el aviso al tocarlo dentro de la app. Si no se indica y el
        aviso va al celular, se reutiliza la dirección de aquel: es la misma. */
    enlace?: string
  ) => Promise<void>;
  setExecStatus: (taskId: string, status: TaskExecStatus) => Promise<string | void>;
  addChatMessage: (
    taskId: string,
    text: string,
    adjuntos?: File[],
    destinatario?: string | null,
    /** Avisa qué archivo va subiendo, para poder mostrar "Enviando 2 de 3". */
    alAvanzar?: (hecho: number, total: number, nombre: string) => void
  ) => Promise<string | void>;
  /** Vuelve a traer la conversación de una tarea (al abrirla o tras inscribirse). */
  refreshTaskChat: (taskId: string) => Promise<void>;
  toggleReaction: (taskId: string, messageId: string, emoji: "👍" | "❤️" | "✅") => Promise<void>;
  /** Elimina un mensaje del chat (solo el autor o un administrador). */
  deleteChatMessage: (taskId: string, messageId: string) => Promise<string | void>;
  /** Sube un archivo real y devuelve su enlace público. */
  uploadFile: (file: File, carpeta: string) => Promise<{ url: string; name: string } | string>;
  addEvidence: (taskId: string, file: File) => Promise<string | void>;
  removeEvidence: (taskId: string, itemId: string) => Promise<string | void>;
  /** Nota del mural de un mes ("AAAA-MM"). */
  monthNote: (mes: string) => MonthNote | undefined;
  saveMonthNote: (mes: string, contenido: string) => Promise<string | void>;
  addCalendarEntry: (entry: Omit<CalendarEntry, "id">) => Promise<void>;
  /** Lleva un evento del muro al calendario institucional. Siempre a petición. */
  llevarEventoAlCalendario: (eventId: string) => Promise<string | void>;
  /** Quita del calendario la fecha que salió de ese evento. */
  quitarEventoDelCalendario: (eventId: string) => Promise<string | void>;
  /** La fecha del calendario que corresponde a un evento, si existe. */
  fechaDeEvento: (eventId: string) => CalendarEntry | undefined;
  updateCalendarEntry: (id: string, patch: Partial<Omit<CalendarEntry, "id">>) => Promise<void>;
  removeCalendarEntry: (id: string) => Promise<void>;

  /* --- Pizarra de asignaciones --- */
  /** Crea una pizarra nueva con una fila por cada curso del colegio. */
  crearPizarra: (datos: { title: string; date?: string; session?: string; notes?: string }) => Promise<string | void>;
  /** Escribe la asignación, la cuenta y el ayudante de una fila. Solo administración. */
  guardarFilaPizarra: (filaId: string, datos: { asignacion: string; presupuesto: string; ayudante: string }) => Promise<string | void>;
  /** Marca o desmarca una fila como hecha. Cualquiera del personal. */
  marcarFilaPizarra: (filaId: string, hecho: boolean) => Promise<string | void>;
  /** Cierra o reabre la pizarra. */
  cambiarEstadoPizarra: (pizarraId: string, status: "abierta" | "cerrada") => Promise<string | void>;
  eliminarPizarra: (pizarraId: string) => Promise<string | void>;
  updateSettings: (patch: Partial<InstitutionSettings>) => Promise<void>;
  addUser: (data: { name: string; email: string; role: "admin" | "member"; title?: string; area?: string }) => Promise<{ error?: string; credenciales?: Credenciales }>;
  /** Genera una contraseña nueva para alguien y la devuelve. */
  resetUserPassword: (id: string) => Promise<{ error?: string; credenciales?: Credenciales }>;
  updateUserRole: (id: string, role: "admin" | "member") => Promise<string | void>;
  updateProfile: (patch: { name?: string; title?: string; area?: string }) => Promise<void>;
  /** Un administrador corrige los datos de cualquier persona del equipo. */
  updateUserInfo: (id: string, patch: { name?: string; title?: string; area?: string }) => Promise<string | void>;
  removeUser: (id: string) => Promise<string | void>;
  resendInvite: (email: string) => Promise<string | void>;
  searchAll: (q: string) => { events: SchoolEvent[]; tasks: EventTask[]; people: StaffUser[] };
  markNotificationRead: (id: string) => Promise<void>;
  markAllNotificationsRead: () => Promise<void>;
  /** Envía el correo para crear o recuperar la contraseña. */
  sendPasswordLink: (email: string) => Promise<string | void>;
  /** Cada persona puede cambiar su propia contraseña desde su perfil. */
  changeMyPassword: (nueva: string) => Promise<string | void>;
  login: (email: string, password: string) => Promise<string | void>;
  logout: () => Promise<void>;
  logHistory: (action: string, detail: string, type: HistoryEntry["type"]) => void;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<StoredState>(emptyState);
  const stateRef = useRef(state);
  stateRef.current = state;
  /* Puente para que el canal de tiempo real pueda recargar la pizarra sin
     depender del orden en que se declaran las funciones más abajo. */
  const recargarPizarrasRef = useRef<(() => Promise<void>) | null>(null);

  /** Carga todo lo visible para la sesión actual (RLS decide qué llega). */
  const loadAll = useCallback(async (userId: string) => {
    if (!supabase) return;
    const [profilesR, eventsR, tasksR, chatR, notifR, readsR, calR, muralR, histR, settingsR, pizR, pizFilasR] = await Promise.all([
      supabase.from("profiles").select("*"),
      supabase.from("events").select("*").order("created_at", { ascending: false }),
      supabase.from("event_tasks").select("*"),
      supabase.from("task_chat_messages").select("*").order("created_at", { ascending: true }),
      supabase.from("notifications").select("*").order("created_at", { ascending: false }),
      supabase.from("notification_reads").select("notification_id").eq("user_id", userId),
      supabase.from("calendar_entries").select("*").order("date", { ascending: true }),
      supabase.from("month_notes").select("*"),
      supabase.from("history_log").select("*").order("created_at", { ascending: false }).limit(500),
      supabase.from("institution_settings").select("*").single(),
      supabase.from("pizarras").select("*").order("created_at", { ascending: false }),
      supabase.from("pizarra_filas").select("*").order("orden", { ascending: true }),
    ]);

    const chatByTask = new Map<string, ChatMessage[]>();
    (chatR.data ?? []).forEach((r) => {
      const list = chatByTask.get(r.task_id) ?? [];
      list.push(mapChat(r));
      chatByTask.set(r.task_id, list);
    });
    chatByTask.forEach((lista) => lista.sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
    const tasks = (tasksR.data ?? []).map((r) => mapTask(r, chatByTask.get(r.id) ?? []));
    const taskIdsByEvent = new Map<string, string[]>();
    tasks.forEach((t) => {
      const list = taskIdsByEvent.get(t.eventId) ?? [];
      list.push(t.id);
      taskIdsByEvent.set(t.eventId, list);
    });
    const events = (eventsR.data ?? []).map((r) => mapEvent(r, taskIdsByEvent.get(r.id) ?? []));
    const readIds = new Set((readsR.data ?? []).map((r) => r.notification_id));

    setState((prev) => ({
      ...prev,
      users: (profilesR.data ?? []).map(mapProfile),
      events,
      tasks,
      calendar: (calR.data ?? []).map(mapCalendar),
      monthNotes: (muralR.data ?? []).map(mapMonthNote),
      history: (histR.data ?? []).map(mapHistory),
      pizarras: (pizR.data ?? []).map((r) => mapPizarra(r, pizFilasR.data ?? [])),
      notifications: (notifR.data ?? []).map((r) => mapNotification(r, readIds)),
      settings: settingsR.data ? mapSettings(settingsR.data) : defaultSettings,
      currentUserId: userId,
      loggedIn: true,
      loading: false,
    }));
  }, []);

  /* --------------------------------------------------------
     Sesión: revisa si ya hay una, y escucha cambios (login/logout,
     además del enlace mágico que llega por correo de invitación).
     -------------------------------------------------------- */
  useEffect(() => {
    if (!supabase) {
      setState((prev) => ({ ...prev, loading: false }));
      return;
    }
    let unsub = () => {};
    supabase.auth.getSession().then(({ data }) => {
      if (data.session?.user) {
        loadAll(data.session.user.id);
      } else {
        setState((prev) => ({ ...prev, loading: false }));
      }
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_IN" && session?.user) {
        loadAll(session.user.id);
      } else if (event === "SIGNED_OUT") {
        setState((prev) => ({ ...emptyState, loading: false }));
      }
    });
    unsub = () => sub.subscription.unsubscribe();
    return unsub;
  }, [loadAll]);

  /* --------------------------------------------------------
     Tiempo real: cuando cualquier persona conectada cambia algo,
     todos los navegadores conectados se actualizan solos.
     -------------------------------------------------------- */
  useEffect(() => {
    if (!supabase || !state.loggedIn) return;

    const upsert = <T extends { id: string }>(list: T[], row: T, deleted: boolean) => {
      if (deleted) return list.filter((x) => x.id !== row.id);
      const idx = list.findIndex((x) => x.id === row.id);
      if (idx === -1) return [row, ...list];
      const next = [...list];
      next[idx] = row;
      return next;
    };

    // El tipado de los canales de Realtime es muy estricto; lo relajamos aquí
    // porque el contenido de cada fila ya se normaliza en las funciones map*.
    const channel = (supabase.channel("staff-board-realtime") as any)
      .on("postgres_changes", { event: "*", schema: "public", table: "events" }, (payload: any) => {
        setState((prev) => {
          const deleted = payload.eventType === "DELETE";
          const row = deleted ? payload.old : payload.new;
          const taskIds = prev.tasks.filter((t) => t.eventId === row.id).map((t) => t.id);
          return { ...prev, events: upsert(prev.events, mapEvent(row, taskIds), deleted) };
        });
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "event_tasks" }, (payload: any) => {
        setState((prev) => {
          const deleted = payload.eventType === "DELETE";
          const row = deleted ? payload.old : payload.new;
          const existingChat = prev.tasks.find((t) => t.id === row.id)?.chat ?? [];
          const nextTasks = upsert(prev.tasks, mapTask(row, existingChat), deleted);
          const taskIds = nextTasks.filter((t) => t.eventId === row.event_id).map((t) => t.id);
          return {
            ...prev,
            tasks: nextTasks,
            events: prev.events.map((e) => (e.id === row.event_id ? { ...e, taskIds } : e)),
          };
        });
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "task_chat_messages" }, (payload: any) => {
        setState((prev) => {
          const deleted = payload.eventType === "DELETE";
          const row = deleted ? payload.old : payload.new;
          return {
            ...prev,
            tasks: prev.tasks.map((t) => {
              if (t.id !== row.task_id) return t;
              const chat = upsert(t.chat, mapChat(row), deleted).sort((a, b) =>
                a.createdAt.localeCompare(b.createdAt)
              );
              return { ...t, chat };
            }),
          };
        });
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "profiles" }, (payload: any) => {
        setState((prev) => {
          const deleted = payload.eventType === "DELETE";
          const row = deleted ? payload.old : payload.new;
          if (!row?.id) return prev;
          return { ...prev, users: upsert(prev.users, mapProfile(row), deleted) };
        });
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "month_notes" }, (payload: any) => {
        setState((prev) => {
          const deleted = payload.eventType === "DELETE";
          const row = deleted ? payload.old : payload.new;
          if (!row?.month) return prev;
          const resto = prev.monthNotes.filter((n) => n.month !== row.month);
          return { ...prev, monthNotes: deleted ? resto : [...resto, mapMonthNote(row)] };
        });
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "calendar_entries" }, (payload: any) => {
        setState((prev) => {
          const deleted = payload.eventType === "DELETE";
          const row = deleted ? payload.old : payload.new;
          if (!row?.id) return prev;
          const calendar = upsert(prev.calendar, mapCalendar(row), deleted).sort((a, b) =>
            a.date.localeCompare(b.date)
          );
          return { ...prev, calendar };
        });
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "notifications" }, (payload: any) => {
        /* Si llega un aviso nuevo mientras la app está abierta, el teléfono da un
           toque corto. Con la app cerrada de esto se encarga el service worker. */
        if (payload.eventType === "INSERT" && typeof navigator !== "undefined" && navigator.vibrate) {
          try { navigator.vibrate(120); } catch { /* el aparato no vibra */ }
        }
        setState((prev) => {
          const deleted = payload.eventType === "DELETE";
          const row = deleted ? payload.old : payload.new;
          const alreadyRead = prev.notifications.find((n) => n.id === row.id)?.read ?? false;
          return { ...prev, notifications: upsert(prev.notifications, mapNotification(row, alreadyRead ? new Set([row.id]) : new Set()), deleted) };
        });
      })
      /* La pizarra cambia mientras varias personas la miran a la vez, así que
         cualquier cambio recarga la sección entera: son pocos datos y así
         nunca queda medio actualizada. */
      .on("postgres_changes", { event: "*", schema: "public", table: "pizarras" }, () => {
        recargarPizarrasRef.current?.();
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "pizarra_filas" }, () => {
        recargarPizarrasRef.current?.();
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [state.loggedIn]);

  const currentUser = useMemo(
    () => state.users.find((u) => u.id === state.currentUserId) ?? ({ id: "", name: "", email: "", role: "member", status: "active", initials: "", color: "#146942", joinedAt: "" } as StaffUser),
    [state.users, state.currentUserId]
  );
  const isAdmin = currentUser?.role === "admin";

  const logHistory = useCallback<AppContextValue["logHistory"]>((action, detail, type) => {
    if (!supabase) return;
    supabase.from("history_log").insert({ user_id: stateRef.current.currentUserId, action, detail, type }).then();
  }, []);

  const taskAudience = useCallback(
    (task: EventTask, includeWaitlist = false) => {
      const event = stateRef.current.events.find((e) => e.id === task.eventId);
      return [
        ...task.slots.map((s) => s.userId),
        task.leaderId,
        event?.createdBy,
        ...(includeWaitlist ? task.waitlist : []),
      ].filter((x): x is string => !!x);
    },
    []
  );

  const notify: AppContextValue["notify"] = useCallback(async (title, detail, audience = "all", alCelular = false, enlace) => {
    if (!supabase) return;

    const paraTodos = audience === "all";
    let destinatarios: string[] = [];

    if (audience === "admins") {
      destinatarios = stateRef.current.users.filter((u) => u.role === "admin").map((u) => u.id);
    } else if (Array.isArray(audience)) {
      destinatarios = audience;
    }

    // A uno mismo no se le avisa de lo que acaba de hacer.
    const dest = Array.from(new Set(destinatarios)).filter((id) => id && id !== stateRef.current.currentUserId);
    if (!paraTodos && dest.length === 0) return;

    /* Si el aviso ya sabía a dónde llevar en el celular, ese mismo destino vale
       dentro de la app: es el mismo sitio. Así los avisos importantes quedaron
       enlazados sin tener que repetir la dirección en cada llamada. */
    const destino = enlace ?? (alCelular ? alCelular.url : undefined) ?? null;

    await supabase.rpc("notify", {
      p_title: title,
      p_detail: detail,
      p_audience_all: paraTodos,
      p_audience_users: dest,
      p_link: destino,
    });

    /* Aviso al celular. Solo para lo que le importa a todo el colegio, y solo
       cuando el aviso es para todos: nunca por tareas ni por el chat. */
    if (alCelular && paraTodos) {
      await avisarAlEquipo({
        autorId: stateRef.current.currentUserId,
        titulo: title,
        detalle: detail,
        url: alCelular.url,
      });
    }
  }, []);

  const liveTasks = useMemo(() => state.tasks.filter((t) => !t.archived), [state.tasks]);

  const runArchiveSweep: AppContextValue["runArchiveSweep"] = useCallback(async () => {
    if (!supabase) return 0;
    const target = state.tasks.filter((t) => shouldArchive(t, state.settings.archiveAfterDays));
    if (target.length === 0) return 0;
    await supabase.from("event_tasks").update({ archived: true }).in("id", target.map((t) => t.id));
    logHistory("archivó automáticamente", `${target.length} tarea(s) vencida(s)`, "Configuración");
    await notify(
      "Mantenimiento automático",
      `Se archivaron ${target.length} tarea(s) vencida(s) según la regla de la institución`,
      "admins"
    );
    return target.length;
  }, [state.tasks, state.settings.archiveAfterDays, logHistory, notify]);

  const runDeadlineAlerts: AppContextValue["runDeadlineAlerts"] = useCallback(async () => {
    if (!supabase || !state.settings.notifyDeadline) return 0;
    const target = state.tasks.filter((t) => !t.archived && isDueSoon(t) && !t.deadlineNotified);
    if (target.length === 0) return 0;
    await supabase.from("event_tasks").update({ deadline_notified: true }).in("id", target.map((t) => t.id));
    for (const t of target) {
      await notify("Fecha límite próxima", `${t.name} — ${dueLabel(t).toLowerCase()}`, taskAudience(t, true), false, `/eventos/${t.eventId}`);
    }
    return target.length;
  }, [state.tasks, state.settings.notifyDeadline, notify, taskAudience]);

  const eventById = useCallback((id: string) => state.events.find((e) => e.id === id), [state.events]);
  const tasksForEvent = useCallback((eventId: string) => state.tasks.filter((t) => t.eventId === eventId), [state.tasks]);
  const userById = useCallback((id: string) => state.users.find((u) => u.id === id), [state.users]);

  const canSeeEvent = useCallback(
    (event: SchoolEvent) => event.status === "publicado" || event.createdBy === currentUser?.id || isAdmin,
    [isAdmin, currentUser]
  );
  const visibleEvents = useMemo(
    () => state.events.filter((e) => e.status === "publicado" || e.createdBy === currentUser?.id || isAdmin),
    [state.events, currentUser, isAdmin]
  );
  /**
   * El muro se ordena por la fecha en que ocurre cada evento, no por cuándo se
   * creó. Primero lo que está más cerca de suceder, que es lo que la gente
   * necesita ver al abrir la aplicación.
   *
   * Lo que ya pasó pero sigue publicado se va al final, de lo más reciente a lo
   * más antiguo: sigue estando accesible, pero deja de estorbar arriba.
   */
  const wallEvents = useMemo(() => {
    const hoy = new Date().toISOString().slice(0, 10);
    const publicados = state.events.filter((e) => e.status === "publicado");

    const conFecha = publicados.filter((e) => !!e.eventDate);
    const sinFecha = publicados.filter((e) => !e.eventDate);

    const porVenir = conFecha
      .filter((e) => e.eventDate >= hoy)
      .sort((a, b) => a.eventDate.localeCompare(b.eventDate));

    const yaPasaron = conFecha
      .filter((e) => e.eventDate < hoy)
      .sort((a, b) => b.eventDate.localeCompare(a.eventDate));

    // Los que no tienen fecha van entre medias: no son urgentes, pero tampoco
    // son pasado. Entre ellos, el más nuevo primero.
    const huerfanos = sinFecha.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));

    return [...porVenir, ...huerfanos, ...yaPasaron];
  }, [state.events]);
  const myEvents = useMemo(() => state.events.filter((e) => e.createdBy === currentUser?.id), [state.events, currentUser]);

  const canEditEvent = useCallback((event: SchoolEvent) => isAdmin || event.createdBy === currentUser?.id, [isAdmin, currentUser]);
  const canDeleteTask = useCallback(
    (task: EventTask) => {
      const event = eventById(task.eventId);
      return isAdmin || (event ? event.createdBy === currentUser?.id : false);
    },
    [isAdmin, currentUser, eventById]
  );

  const createEvent: AppContextValue["createEvent"] = useCallback(
    async (data) => {
      if (!supabase || !currentUser?.id) return null;
      const { data: row, error } = await supabase
        .from("events")
        .insert({
          name: data.name,
          description: data.description ?? "",
          cover_emoji: data.coverEmoji ?? "📌",
          cover_image: data.coverImage ?? null,
          color: data.color ?? "brand",
          event_date: data.eventDate ?? new Date().toISOString().slice(0, 10),
          due_date: data.dueDate ?? null,
          status: data.status ?? "borrador",
          created_by: currentUser.id,
        })
        .select()
        .single();
      if (error || !row) return null;
      logHistory("creó el evento", row.name, "Evento");
      return mapEvent(row, []);
    },
    [currentUser, logHistory]
  );

  const updateEvent: AppContextValue["updateEvent"] = useCallback(
    async (id, patch) => {
      if (!supabase) return;
      const prevEvent = state.events.find((e) => e.id === id);
      const dbPatch: Record<string, unknown> = {};
      if (patch.name !== undefined) dbPatch.name = patch.name;
      if (patch.description !== undefined) dbPatch.description = patch.description;
      if (patch.coverEmoji !== undefined) dbPatch.cover_emoji = patch.coverEmoji;
      if (patch.coverImage !== undefined) dbPatch.cover_image = patch.coverImage || null;
      if (patch.color !== undefined) dbPatch.color = patch.color;
      if (patch.eventDate !== undefined) dbPatch.event_date = patch.eventDate;
      if (patch.dueDate !== undefined) dbPatch.due_date = patch.dueDate;
      if (patch.status !== undefined) dbPatch.status = patch.status;
      await supabase.from("events").update(dbPatch).eq("id", id);

      /* Si este evento está puesto en el calendario del colegio y le cambian la
         fecha o el nombre, la fecha del calendario se corrige sola. Si no, el
         calendario acabaría anunciando algo que ya no es verdad. */
      if (patch.eventDate !== undefined || patch.name !== undefined) {
        const enCalendario = stateRef.current.calendar.find((c) => c.eventId === id);
        if (enCalendario) {
          const arreglo: Record<string, unknown> = {};
          if (patch.eventDate !== undefined) arreglo.date = patch.eventDate;
          if (patch.name !== undefined) arreglo.title = patch.name;
          if (Object.keys(arreglo).length > 0) {
            await supabase.from("calendar_entries").update(arreglo).eq("id", enCalendario.id);
            const { data: cal } = await supabase
              .from("calendar_entries")
              .select("*")
              .order("date", { ascending: true });
            if (cal) setState((prev) => ({ ...prev, calendar: cal.map(mapCalendar) }));
          }
        }
      }
      if (patch.status && patch.status !== prevEvent?.status) {
        logHistory(patch.status === "publicado" ? "publicó el evento" : "cambió el estado de", prevEvent?.name ?? "", "Evento");
        const nombreEv = prevEvent?.name ?? "";
        if (patch.status === "publicado") {
          await notify("Nuevo evento publicado", `${currentUser?.name ?? "Alguien"} publicó ${nombreEv}. Ya puedes inscribirte en sus tareas.`, "all", { url: `/eventos/${id}` });
        } else if (patch.status === "finalizado") {
          await notify("Evento finalizado", `${nombreEv} se dio por terminado.`, "all", false, `/eventos/${id}`);
        } else if (patch.status === "archivado") {
          await notify("Evento archivado", `${nombreEv} pasó al archivo.`, "admins", false, `/eventos/${id}`);
        }
      } else {
        logHistory("editó el evento", prevEvent?.name ?? "", "Evento");
        // La especificación pide avisar cuando se mueve una fecha importante.
        const cambioFecha =
          (patch.eventDate !== undefined && patch.eventDate !== prevEvent?.eventDate) ||
          (patch.dueDate !== undefined && patch.dueDate !== prevEvent?.dueDate);
        if (cambioFecha && prevEvent?.status === "publicado") {
          await notify(
            "Cambió una fecha importante",
            `${prevEvent?.name}: ahora es el ${patch.eventDate ?? prevEvent?.eventDate}`,
            "all",
            false,
            `/eventos/${id}`
          );
        }
      }
    },
    [state.events, logHistory, notify, currentUser]
  );

  const deleteEvent: AppContextValue["deleteEvent"] = useCallback(
    async (id) => {
      if (!supabase) return;
      const event = state.events.find((e) => e.id === id);
      await supabase.from("events").delete().eq("id", id);
      if (event) {
        logHistory("eliminó el evento", event.name, "Evento");
        await notify(
          "Evento eliminado",
          `${currentUser?.name ?? "Alguien"} eliminó ${event.name}`,
          event.status === "publicado" ? "all" : "admins"
        );
      }
    },
    [state.events, logHistory]
  );

  const duplicateEvent: AppContextValue["duplicateEvent"] = useCallback(
    async (id) => {
      if (!supabase || !currentUser?.id) return;
      const event = state.events.find((e) => e.id === id);
      if (!event) return;
      const relatedTasks = state.tasks.filter((t) => t.eventId === id);
      const { data: newEventRow, error } = await supabase
        .from("events")
        .insert({
          name: `${event.name} · nueva edición`,
          description: event.description,
          cover_emoji: event.coverEmoji,
          cover_image: event.coverImage ?? null,
          color: event.color,
          event_date: event.eventDate,
          due_date: event.dueDate ?? null,
          status: "borrador",
          created_by: currentUser.id,
        })
        .select()
        .single();
      if (error || !newEventRow) return;
      if (relatedTasks.length > 0) {
        await supabase.from("event_tasks").insert(
          relatedTasks.map((t) => ({
            event_id: newEventRow.id,
            name: t.name,
            description: t.description,
            color: t.color,
            priority: t.priority,
            status: "sin_iniciar",
            due_date: t.dueDate,
            max_collaborators: t.maxCollaborators,
            reference_image: t.referenceImage ?? null,
            slots: t.slots.map(() => ({ userId: null, claimedAt: null })),
            requires_leader: t.requiresLeader,
            leader_id: t.leaderId,
            waitlist: [],
            evidence: [],
            attachments: [],
          }))
        );
      }
      logHistory("creó el evento", newEventRow.name, "Evento");
    },
    [state.events, state.tasks, currentUser, logHistory]
  );

  const createTask: AppContextValue["createTask"] = useCallback(
    async (data) => {
      if (!supabase) return null;
      const max = data.maxCollaborators ?? 1;
      const { data: row, error } = await supabase
        .from("event_tasks")
        .insert({
          event_id: data.eventId,
          name: data.name,
          description: data.description ?? "",
          color: data.color ?? "brand",
          priority: data.priority ?? "media",
          status: "sin_iniciar",
          due_date: data.dueDate ?? new Date().toISOString().slice(0, 10),
          max_collaborators: max,
          reference_image: data.referenceImage ?? null,
          requires_leader: data.requiresLeader ?? false,
          leader_id: data.leaderId ?? null,
          slots: Array.from({ length: max }, () => ({ userId: null, claimedAt: null })),
          waitlist: [],
          evidence: [],
          attachments: [],
        })
        .select()
        .single();
      if (error || !row) return null;
      logHistory("creó la tarea", row.name, "Tarea");
      // Si el evento ya está publicado, hay cupos nuevos para todo el personal.
      const evento = stateRef.current.events.find((e) => e.id === data.eventId);
      if (evento?.status === "publicado") {
        await notify(
          "Nueva tarea disponible",
          `${row.name} en ${evento.name} · ${max} lugar(es) para colaborar`,
          "all",
          false,
          `/eventos/${data.eventId}`
        );
      }
      return mapTask(row, []);
    },
    [logHistory]
  );

  const updateTask: AppContextValue["updateTask"] = useCallback(async (id, patch) => {
    if (!supabase) return;
    const actual = stateRef.current.tasks.find((t) => t.id === id);
    const dbPatch: Record<string, unknown> = {};

    /* Si cambia la cantidad de colaboradores hay que redimensionar los lugares
       conservando a quienes ya están inscritos. Nunca por debajo de los ocupados. */
    if (actual && patch.maxCollaborators !== undefined && patch.maxCollaborators !== actual.maxCollaborators) {
      const ocupados = actual.slots.filter((sl) => sl.userId);
      const objetivo = Math.max(patch.maxCollaborators, ocupados.length, 1);
      const nuevos = [...ocupados];
      while (nuevos.length < objetivo) nuevos.push({ userId: null, claimedAt: null });
      dbPatch.slots = nuevos;
      dbPatch.max_collaborators = objetivo;
    }

    if (patch.name !== undefined) dbPatch.name = patch.name;
    if (patch.description !== undefined) dbPatch.description = patch.description;
    if (patch.color !== undefined) dbPatch.color = patch.color;
    if (patch.priority !== undefined) dbPatch.priority = patch.priority;
    if (patch.status !== undefined) dbPatch.status = patch.status;
    if (patch.dueDate !== undefined) dbPatch.due_date = patch.dueDate;
    if (patch.maxCollaborators !== undefined && dbPatch.max_collaborators === undefined)
      dbPatch.max_collaborators = patch.maxCollaborators;
    if (patch.referenceImage !== undefined) dbPatch.reference_image = patch.referenceImage || null;
    if (patch.requiresLeader !== undefined) dbPatch.requires_leader = patch.requiresLeader;
    if (patch.leaderId !== undefined) dbPatch.leader_id = patch.leaderId;
    if (patch.slots !== undefined) dbPatch.slots = patch.slots;
    await supabase.from("event_tasks").update(dbPatch).eq("id", id);
  }, []);

  const deleteTask: AppContextValue["deleteTask"] = useCallback(
    async (id) => {
      if (!supabase) return;
      const task = state.tasks.find((t) => t.id === id);
      await supabase.from("event_tasks").delete().eq("id", id);
      if (task) logHistory("eliminó la tarea", task.name, "Tarea");
    },
    [state.tasks, logHistory]
  );

  /* ----- acciones sensibles a condiciones de carrera: pasan por RPC ----- */
  const claimSlot: AppContextValue["claimSlot"] = useCallback(
    async (taskId, slotIndex) => {
      if (!supabase) return "Supabase no está configurado";
      const { error } = await supabase.rpc("claim_slot", { p_task_id: taskId, p_slot_index: slotIndex });
      if (error) return error.message;

      // Quien organiza el evento debe enterarse de que ya hay quien ayude.
      const t = stateRef.current.tasks.find((x) => x.id === taskId);
      const ev = stateRef.current.events.find((e) => e.id === t?.eventId);
      const avisar = [ev?.createdBy, t?.leaderId].filter((x): x is string => !!x);
      if (t && avisar.length > 0) {
        await notify(
          "Alguien se inscribió",
          `${currentUser?.name ?? "Un colaborador"} se inscribió en ${t.name}`,
          avisar,
          false,
          `/eventos/${t.eventId}`
        );
      }
    },
    [notify, currentUser]
  );

  const cancelSlot: AppContextValue["cancelSlot"] = useCallback(
    async (taskId) => {
      if (!supabase) return "Supabase no está configurado";
      const t = stateRef.current.tasks.find((x) => x.id === taskId);
      const { error } = await supabase.rpc("cancel_slot", { p_task_id: taskId });
      if (error) return error.message;

      const ev = stateRef.current.events.find((e) => e.id === t?.eventId);
      const avisar = [ev?.createdBy, t?.leaderId].filter((x): x is string => !!x);
      if (t && avisar.length > 0) {
        await notify(
          "Se liberó un lugar",
          `${currentUser?.name ?? "Un colaborador"} canceló su inscripción en ${t.name}`,
          avisar,
          false,
          `/eventos/${t.eventId}`
        );
      }
    },
    [notify, currentUser]
  );

  const confirmSlot: AppContextValue["confirmSlot"] = useCallback(async (taskId) => {
    if (!supabase) return "Supabase no está configurado";
    const { error } = await supabase.rpc("confirmar_inscripcion", { p_task_id: taskId });
    if (error) {
      return error.message.toLowerCase().includes("does not exist")
        ? "Falta aplicar el SQL 'CONFIRMAR-Y-BORRAR' en Supabase."
        : error.message;
    }
  }, []);

  const quitarInscripcion: AppContextValue["quitarInscripcion"] = useCallback(
    async (taskId, userId) => {
      if (!supabase) return "Supabase no está configurado";
      const t = stateRef.current.tasks.find((x) => x.id === taskId);
      const { error } = await supabase.rpc("quitar_inscripcion", { p_task_id: taskId, p_user_id: userId });
      if (error) {
        return error.message.toLowerCase().includes("does not exist")
          ? "Falta aplicar el SQL 'QUITAR-INSCRIPCION' en Supabase."
          : error.message;
      }

      // Al organizador y al líder les avisamos igual que cuando alguien cancela.
      const ev = stateRef.current.events.find((e) => e.id === t?.eventId);
      const avisar = [ev?.createdBy, t?.leaderId].filter((x): x is string => !!x && x !== userId);
      if (t && avisar.length > 0) {
        const quien = userId === stateRef.current.currentUserId
          ? `${currentUser?.name ?? "Un administrador"} canceló su inscripción`
          : `${currentUser?.name ?? "Un administrador"} quitó a ${stateRef.current.users.find((u) => u.id === userId)?.name ?? "un colaborador"}`;
        await notify("Se liberó un lugar", `${quien} en ${t.name}`, avisar, false, `/eventos/${t.eventId}`);
      }
    },
    [notify, currentUser]
  );

  const joinWaitlist: AppContextValue["joinWaitlist"] = useCallback(async (taskId) => {
    if (!supabase) return "Supabase no está configurado";
    const { error } = await supabase.rpc("join_waitlist", { p_task_id: taskId });
    if (error) return error.message;
  }, []);

  const leaveWaitlist: AppContextValue["leaveWaitlist"] = useCallback(async (taskId) => {
    if (!supabase) return "Supabase no está configurado";
    const { error } = await supabase.rpc("leave_waitlist", { p_task_id: taskId });
    if (error) return error.message;
  }, []);

  const setExecStatus: AppContextValue["setExecStatus"] = useCallback(async (taskId, status) => {
    if (!supabase) return "Supabase no está configurado";
    const { error } = await supabase.rpc("set_exec_status", { p_task_id: taskId, p_status: status });
    if (error) return error.message;
  }, []);

  /**
   * Sube un archivo al almacenamiento del colegio y devuelve su enlace.
   * Si algo falla devuelve un texto con el motivo, para mostrarlo en pantalla.
   */
  const uploadFile: AppContextValue["uploadFile"] = useCallback(async (file, carpeta) => {
    if (!supabase) return "Supabase no está configurado";
    const LIMITE = 25 * 1024 * 1024;
    if (file.size > LIMITE) return "El archivo supera el límite de 25 MB.";
    const limpio = file.name.replace(/[^\w.\-]+/g, "_").slice(-80);
    const ruta = `${carpeta}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${limpio}`;
    const { error } = await supabase.storage.from("staffboard").upload(ruta, file, {
      cacheControl: "3600",
      upsert: false,
      contentType: file.type || undefined,
    });
    if (error) {
      const m = error.message.toLowerCase();
      if (m.includes("bucket")) return "Falta crear el almacén de archivos en Supabase (ejecuta ARREGLO-ADJUNTOS.sql).";
      if (m.includes("policy") || m.includes("permission") || m.includes("unauthorized")) {
        return "El almacén de archivos no te deja subir. Ejecuta ARREGLO-ADJUNTOS.sql en Supabase.";
      }
      if (m.includes("payload") || m.includes("too large")) return "El archivo es demasiado grande (máximo 25 MB).";
      return `No se pudo subir el archivo: ${error.message}`;
    }
    const { data } = supabase.storage.from("staffboard").getPublicUrl(ruta);
    return { url: data.publicUrl, name: file.name };
  }, []);

  const esImagen = (f: File) => f.type.startsWith("image/");

  const addChatMessage: AppContextValue["addChatMessage"] = useCallback(
    async (taskId, text, adjuntos = [], destinatario = null, alAvanzar) => {
      if (!supabase) return "Supabase no está configurado";
      const subidos: {
        id: string; type: "image" | "file"; name: string; url: string; uploadedBy: string; uploadedAt: string;
      }[] = [];
      for (let i = 0; i < adjuntos.length; i++) {
        const original = adjuntos[i];
        alAvanzar?.(i, adjuntos.length, original.name);

        /* Las fotos se encogen antes de salir del teléfono. Sin esto, una foto
           de 6 MB por datos móviles tarda una eternidad y a veces se corta. */
        const f = original.type.startsWith("image/") ? await comprimirImagen(original) : original;

        const r = await uploadFile(f, `chat/${taskId}`);
        if (typeof r === "string") {
          // Decimos QUÉ archivo falló: con varios adjuntos, "no se pudo subir"
          // a secas no le sirve de nada a nadie.
          return adjuntos.length > 1 ? `«${original.name}»: ${r}` : r;
        }
        subidos.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          type: original.type.startsWith("image/") ? "image" : "file",
          name: original.name,
          url: r.url,
          uploadedBy: stateRef.current.currentUserId,
          uploadedAt: new Date().toISOString(),
        });
      }
      alAvanzar?.(adjuntos.length, adjuntos.length, "");
      const { data, error } = await supabase.rpc("add_chat_message", {
        p_task_id: taskId,
        p_text: text,
        p_attachments: subidos,
        p_recipient: destinatario,
      });
      if (error) {
        const m = error.message.toLowerCase();
        if (m.includes("could not choose") || m.includes("does not exist") || m.includes("not find the function")) {
          return "Falta aplicar ARREGLO-ADJUNTOS.sql en Supabase (la función del chat quedó duplicada).";
        }
        return error.message;
      }

      // Mostrarlo de inmediato sin esperar al aviso en tiempo real.
      // Si el aviso llega después, el mismo id evita que se duplique.
      const fila = Array.isArray(data) ? data[0] : data;
      if (fila?.id) {
        const nuevo = mapChat(fila);
        setState((prev) => ({
          ...prev,
          tasks: prev.tasks.map((t) =>
            t.id !== taskId
              ? t
              : {
                  ...t,
                  chat: [...t.chat.filter((m) => m.id !== nuevo.id), nuevo].sort((a, b) =>
                    a.createdAt.localeCompare(b.createdAt)
                  ),
                }
          ),
        }));
      }
    },
    [uploadFile]
  );

  const refreshTaskChat: AppContextValue["refreshTaskChat"] = useCallback(async (taskId) => {
    if (!supabase) return;
    const { data, error } = await supabase
      .from("task_chat_messages")
      .select("*")
      .eq("task_id", taskId)
      .order("created_at", { ascending: true });
    if (error || !data) return;
    const chat = data.map(mapChat);
    setState((prev) => ({
      ...prev,
      tasks: prev.tasks.map((t) => (t.id === taskId ? { ...t, chat } : t)),
    }));
  }, []);

  const toggleReaction: AppContextValue["toggleReaction"] = useCallback(async (_taskId, messageId, emoji) => {
    if (!supabase) return;
    await supabase.rpc("toggle_reaction", { p_message_id: messageId, p_emoji: emoji });
  }, []);


  /** Sube una evidencia real (foto o documento) a la tarea. */
  const deleteChatMessage: AppContextValue["deleteChatMessage"] = useCallback(async (taskId, messageId) => {
    if (!supabase) return "Supabase no está configurado";
    const { error } = await supabase.rpc("borrar_mensaje", { p_message_id: messageId });
    if (error) {
      return error.message.toLowerCase().includes("does not exist")
        ? "Falta aplicar el SQL 'CONFIRMAR-Y-BORRAR' en Supabase."
        : error.message;
    }
    // Quitarlo de inmediato, sin esperar el aviso en tiempo real.
    setState((prev) => ({
      ...prev,
      tasks: prev.tasks.map((t) =>
        t.id === taskId ? { ...t, chat: t.chat.filter((m) => m.id !== messageId) } : t
      ),
    }));
  }, []);

  const addEvidence: AppContextValue["addEvidence"] = useCallback(
    async (taskId, file) => {
      if (!supabase) return "Supabase no está configurado";
      // Las evidencias son casi siempre fotos: también se encogen antes de subir.
      const ligero = file.type.startsWith("image/") ? await comprimirImagen(file) : file;
      const subido = await uploadFile(ligero, `tareas/${taskId}`);
      if (typeof subido === "string") return subido;
      subido.name = file.name;
      const { error } = await supabase.rpc("add_evidence", {
        p_task_id: taskId,
        p_name: subido.name,
        p_type: esImagen(file) ? "image" : "file",
        p_url: subido.url,
      });
      if (error) {
        const m = error.message.toLowerCase();
        if (m.includes("could not choose") || m.includes("does not exist") || m.includes("not find the function")) {
          return "Falta aplicar ARREGLO-ADJUNTOS.sql en Supabase (la función de evidencias quedó duplicada).";
        }
        return error.message;
      }

      const t = stateRef.current.tasks.find((x) => x.id === taskId);
      if (t) {
        await notify(
          "Nueva evidencia",
          `${currentUser?.name ?? "Alguien"} subió "${subido.name}" en ${t.name}`,
          taskAudience(t),
          false,
          `/eventos/${t.eventId}`
        );
      }
    },
    [uploadFile, notify, currentUser, taskAudience]
  );

  const removeEvidence: AppContextValue["removeEvidence"] = useCallback(async (taskId, itemId) => {
    if (!supabase) return "Supabase no está configurado";
    const { error } = await supabase.rpc("remove_evidence", { p_task_id: taskId, p_item_id: itemId });
    if (error) return error.message;
  }, []);

  const monthNote: AppContextValue["monthNote"] = useCallback(
    (mes) => state.monthNotes.find((n) => n.month === mes),
    [state.monthNotes]
  );

  const saveMonthNote: AppContextValue["saveMonthNote"] = useCallback(
    async (mes, contenido) => {
      if (!supabase) return "Supabase no está configurado";
      const fila = {
        month: mes,
        content: contenido,
        updated_at: new Date().toISOString(),
        updated_by: stateRef.current.currentUserId || null,
      };
      const { error } = await supabase.from("month_notes").upsert(fila, { onConflict: "month" });
      if (error) {
        return error.message.toLowerCase().includes("month_notes")
          ? "Falta aplicar el SQL del mural del mes en Supabase."
          : error.message;
      }
      setState((prev) => {
        const resto = prev.monthNotes.filter((n) => n.month !== mes);
        return {
          ...prev,
          monthNotes: [...resto, mapMonthNote(fila)],
        };
      });
      logHistory("actualizó el mural del mes", mes, "Calendario");
      await notify("Mural del mes actualizado", `${currentUser?.name ?? "Alguien"} escribió en el mural de ${mes}`, "all", { url: "/calendario" });
    },
    [logHistory, notify, currentUser]
  );

  const addCalendarEntry: AppContextValue["addCalendarEntry"] = useCallback(
    async (entry) => {
      if (!supabase) return;
      await supabase.from("calendar_entries").insert({
        date: entry.date,
        title: entry.title,
        kind: entry.kind,
        location: entry.location ?? null,
        time: entry.time ?? null,
        motto: entry.motto ?? null,
        description: entry.description ?? null,
        responsibles: entry.responsibles ?? null,
        custom_kind: entry.customKind ?? null,
        event_id: entry.eventId ?? null,
      });
      logHistory("agregó al calendario institucional", entry.title, "Calendario");
      // La especificación pide avisar a todo el personal de cualquier cambio del calendario.
      await notify(
        "Calendario institucional actualizado",
        `${currentUser?.name ?? "Alguien"} agregó "${entry.title}" el ${entry.date}`,
        "all",
        { url: "/calendario" }
      );
      // Recargar calendario (no está en el canal de tiempo real por simplicidad)
      const { data } = await supabase.from("calendar_entries").select("*").order("date", { ascending: true });
      if (data) setState((prev) => ({ ...prev, calendar: data.map(mapCalendar) }));
    },
    [logHistory, notify, currentUser]
  );

  /* ------------------------------------------------------------------ */
  /* Llevar un evento al calendario. Nunca ocurre solo: alguien lo decide.  */
  /* ------------------------------------------------------------------ */

  const fechaDeEvento: AppContextValue["fechaDeEvento"] = useCallback(
    (eventId) => state.calendar.find((c) => c.eventId === eventId),
    [state.calendar]
  );

  const llevarEventoAlCalendario: AppContextValue["llevarEventoAlCalendario"] = useCallback(
    async (eventId) => {
      const evento = stateRef.current.events.find((e) => e.id === eventId);
      if (!evento) return "No se encontró el evento.";
      if (!evento.eventDate) return "El evento no tiene fecha, así que no se puede colocar en el calendario.";
      if (stateRef.current.calendar.some((c) => c.eventId === eventId)) {
        return "Ese evento ya está en el calendario.";
      }
      await addCalendarEntry({
        date: evento.eventDate,
        title: evento.name,
        kind: "evento",
        description: evento.description || undefined,
        eventId,
      });
    },
    [addCalendarEntry]
  );

  /* ------------------------------------------------------------------ */
  /* Pizarra de asignaciones                                              */
  /* ------------------------------------------------------------------ */

  /** Vuelve a traer las pizarras del servidor. Se usa tras cada cambio. */
  const recargarPizarras = useCallback(async () => {
    if (!supabase) return;
    const [{ data: piz }, { data: filas }] = await Promise.all([
      supabase.from("pizarras").select("*").order("created_at", { ascending: false }),
      supabase.from("pizarra_filas").select("*").order("orden", { ascending: true }),
    ]);
    setState((prev) => ({
      ...prev,
      pizarras: (piz ?? []).map((r) => mapPizarra(r, filas ?? [])),
    }));
  }, []);

  recargarPizarrasRef.current = recargarPizarras;

  const crearPizarra: AppContextValue["crearPizarra"] = useCallback(
    async (datos) => {
      if (!supabase) return "Supabase no está configurado";
      if (!datos.title.trim()) return "Ponle un nombre a la pizarra.";

      const { data: fila, error } = await supabase
        .from("pizarras")
        .insert({
          title: datos.title.trim(),
          date: datos.date || null,
          session: datos.session || null,
          notes: datos.notes || null,
          created_by: stateRef.current.currentUserId,
        })
        .select()
        .single();

      if (error) {
        const m = error.message.toLowerCase();
        if (m.includes("does not exist")) return "Falta ejecutar pizarra.sql en Supabase.";
        if (m.includes("policy") || m.includes("row-level")) return "Solo la administración puede crear pizarras.";
        return error.message;
      }

      /* Una fila por curso, en el mismo orden que la hoja de papel. */
      const filas = CURSOS.map((curso, i) => ({
        pizarra_id: fila.id,
        curso,
        orden: i,
      }));
      const { error: errFilas } = await supabase.from("pizarra_filas").insert(filas);
      if (errFilas) {
        // Si los cursos no entraron, no dejamos una pizarra vacía a medias.
        await supabase.from("pizarras").delete().eq("id", fila.id);
        return errFilas.message;
      }

      logHistory("creó una pizarra de asignaciones", datos.title.trim(), "Evento");
      await notify(
        "Nueva pizarra de asignaciones",
        `${currentUser?.name ?? "Alguien"} publicó "${datos.title.trim()}". Mira lo que le toca a tu curso.`,
        "all",
        { url: "/pizarra" }
      );
      await recargarPizarras();
    },
    [logHistory, notify, currentUser, recargarPizarras]
  );

  const guardarFilaPizarra: AppContextValue["guardarFilaPizarra"] = useCallback(
    async (filaId, datos) => {
      if (!supabase) return "Supabase no está configurado";
      const { error } = await supabase.rpc("pizarra_guardar_fila", {
        p_fila: filaId,
        p_asignacion: datos.asignacion || null,
        p_presupuesto: datos.presupuesto || null,
        p_ayudante: datos.ayudante || null,
      });
      if (error) {
        if (error.message.toLowerCase().includes("does not exist")) return "Falta ejecutar pizarra.sql en Supabase.";
        return error.message;
      }
      await recargarPizarras();
    },
    [recargarPizarras]
  );

  const marcarFilaPizarra: AppContextValue["marcarFilaPizarra"] = useCallback(
    async (filaId, hecho) => {
      if (!supabase) return "Supabase no está configurado";
      const { error } = await supabase.rpc("pizarra_marcar", { p_fila: filaId, p_hecho: hecho });
      if (error) {
        if (error.message.toLowerCase().includes("does not exist")) return "Falta ejecutar pizarra.sql en Supabase.";
        return error.message;
      }
      await recargarPizarras();
    },
    [recargarPizarras]
  );

  const cambiarEstadoPizarra: AppContextValue["cambiarEstadoPizarra"] = useCallback(
    async (pizarraId, status) => {
      if (!supabase) return "Supabase no está configurado";
      const { error } = await supabase.from("pizarras").update({ status }).eq("id", pizarraId);
      if (error) return error.message;
      await recargarPizarras();
    },
    [recargarPizarras]
  );

  const eliminarPizarra: AppContextValue["eliminarPizarra"] = useCallback(
    async (pizarraId) => {
      if (!supabase) return "Supabase no está configurado";
      const previa = stateRef.current.pizarras.find((p) => p.id === pizarraId);
      const { error } = await supabase.from("pizarras").delete().eq("id", pizarraId);
      if (error) return error.message;
      if (previa) logHistory("eliminó una pizarra de asignaciones", previa.title, "Evento");
      await recargarPizarras();
    },
    [logHistory, recargarPizarras]
  );

  const updateCalendarEntry: AppContextValue["updateCalendarEntry"] = useCallback(
    async (id, patch) => {
      if (!supabase) return;
      const dbPatch: Record<string, unknown> = {};
      if (patch.date !== undefined) dbPatch.date = patch.date;
      if (patch.title !== undefined) dbPatch.title = patch.title;
      if (patch.kind !== undefined) dbPatch.kind = patch.kind;
      if (patch.location !== undefined) dbPatch.location = patch.location || null;
      if (patch.time !== undefined) dbPatch.time = patch.time || null;
      if (patch.motto !== undefined) dbPatch.motto = patch.motto || null;
      if (patch.description !== undefined) dbPatch.description = patch.description || null;
      if (patch.responsibles !== undefined) dbPatch.responsibles = patch.responsibles || null;
      if (patch.customKind !== undefined) dbPatch.custom_kind = patch.customKind || null;
      const { error } = await supabase.from("calendar_entries").update(dbPatch).eq("id", id);
      if (error) return;

      /* Sincronía en el otro sentido: si esta fecha viene de un evento del muro
         y aquí le cambian el día o el nombre, el evento se actualiza también.
         Sin esto, el calendario diría una cosa y el muro otra, y nadie sabría
         cuál de las dos es la buena. */
      const anterior = stateRef.current.calendar.find((c) => c.id === id);
      if (anterior?.eventId && (patch.date !== undefined || patch.title !== undefined)) {
        const arregloEvento: Record<string, unknown> = {};
        if (patch.date !== undefined) arregloEvento.event_date = patch.date;
        if (patch.title !== undefined) arregloEvento.name = patch.title;
        if (Object.keys(arregloEvento).length > 0) {
          await supabase.from("events").update(arregloEvento).eq("id", anterior.eventId);
          setState((prev) => ({
            ...prev,
            events: prev.events.map((e) =>
              e.id !== anterior.eventId
                ? e
                : {
                    ...e,
                    eventDate: patch.date ?? e.eventDate,
                    name: patch.title ?? e.name,
                  }
            ),
          }));
        }
      }

      setState((prev) => ({
        ...prev,
        calendar: prev.calendar.map((c) => (c.id === id ? { ...c, ...patch } : c)),
      }));
      const entry = stateRef.current.calendar.find((c) => c.id === id);
      logHistory("actualizó el calendario institucional", patch.title ?? entry?.title ?? "", "Calendario");
      await notify(
        "Calendario institucional actualizado",
        `${currentUser?.name ?? "Alguien"} modificó "${patch.title ?? entry?.title ?? ""}"`,
        "all",
        { url: "/calendario" }
      );
    },
    [logHistory, notify, currentUser]
  );

  const removeCalendarEntry: AppContextValue["removeCalendarEntry"] = useCallback(
    async (id) => {
      if (!supabase) return;
      const entry = state.calendar.find((c) => c.id === id);
      await supabase.from("calendar_entries").delete().eq("id", id);
      setState((prev) => ({ ...prev, calendar: prev.calendar.filter((c) => c.id !== id) }));
      if (entry) {
        logHistory("eliminó del calendario institucional", entry.title, "Calendario");
        await notify(
          "Calendario institucional actualizado",
          `${currentUser?.name ?? "Alguien"} eliminó "${entry.title}" del ${entry.date}`,
          "all",
        { url: "/calendario" }
        );
      }
    },
    [state.calendar, logHistory, notify, currentUser]
  );

  const quitarEventoDelCalendario: AppContextValue["quitarEventoDelCalendario"] = useCallback(
    async (eventId) => {
      const fila = stateRef.current.calendar.find((c) => c.eventId === eventId);
      if (!fila) return "Ese evento no está en el calendario.";
      await removeCalendarEntry(fila.id);
    },
    [removeCalendarEntry]
  );

  const updateSettings: AppContextValue["updateSettings"] = useCallback(
    async (patch) => {
      if (!supabase) return;
      const dbPatch: Record<string, unknown> = {};
      if (patch.name !== undefined) dbPatch.name = patch.name;
      if (patch.officialCalendarUrl !== undefined) dbPatch.official_calendar_url = patch.officialCalendarUrl || null;
      if (patch.officialCalendarName !== undefined) dbPatch.official_calendar_name = patch.officialCalendarName || null;
      if (patch.domain !== undefined) dbPatch.domain = patch.domain;
      if (patch.schoolYear !== undefined) dbPatch.school_year = patch.schoolYear;
      if (patch.timezone !== undefined) dbPatch.timezone = patch.timezone;
      if (patch.cancelWindowMinutes !== undefined) dbPatch.cancel_window_minutes = patch.cancelWindowMinutes;
      if (patch.archiveAfterDays !== undefined) dbPatch.archive_after_days = patch.archiveAfterDays;
      if (patch.requireEvidence !== undefined) dbPatch.require_evidence = patch.requireEvidence;
      if (patch.notifyDeadline !== undefined) dbPatch.notify_deadline = patch.notifyDeadline;
      await supabase.from("institution_settings").update(dbPatch).eq("id", true);
      setState((prev) => ({ ...prev, settings: { ...prev.settings, ...patch } }));
      logHistory("actualizó la configuración institucional", state.settings.name, "Configuración");

      if (patch.officialCalendarUrl) {
        // El calendario oficial le interesa a todo el personal.
        await notify(
          "Calendario oficial actualizado",
          `${currentUser?.name ?? "Alguien"} subió el calendario oficial del colegio`,
          "all"
        );
      } else if (patch.officialCalendarUrl === "") {
        await notify("Calendario oficial", `${currentUser?.name ?? "Alguien"} quitó el calendario oficial`, "admins");
      } else {
        await notify("Configuración institucional", `${currentUser?.name ?? "Alguien"} cambió los ajustes de la plataforma`, "admins");
      }
    },
    [state.settings, logHistory, notify, currentUser]
  );

  /** Invita a alguien nuevo: pasa por /api/invite (usa la llave de servicio). */
  const recargarPersonal = useCallback(async () => {
    if (!supabase) return;
    const { data: profiles } = await supabase.from("profiles").select("*");
    if (profiles) setState((prev) => ({ ...prev, users: profiles.map(mapProfile) }));
  }, []);

  const addUser: AppContextValue["addUser"] = useCallback(
    async (data) => {
      const res = await fetch("/api/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...data, requesterId: stateRef.current.currentUserId }),
      });
      const body = await res.json();
      if (!res.ok) return { error: body.error ?? "No se pudo crear la cuenta." };
      logHistory("agregó al colaborador", data.name, "Equipo");
      await notify("Nueva persona en el equipo", `${currentUser?.name ?? "Alguien"} agregó a ${data.name} (${data.email})`, "admins", false, "/equipo");
      await recargarPersonal();
      return { credenciales: { nombre: data.name, email: body.email, password: body.password } };
    },
    [logHistory, recargarPersonal]
  );

  const resetUserPassword: AppContextValue["resetUserPassword"] = useCallback(
    async (id) => {
      const res = await fetch("/api/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: id, requesterId: stateRef.current.currentUserId }),
      });
      const body = await res.json();
      if (!res.ok) return { error: body.error ?? "No se pudo generar la contraseña." };
      logHistory("generó una contraseña nueva para", body.name ?? "", "Equipo");
      await recargarPersonal();
      return { credenciales: { nombre: body.name, email: body.email, password: body.password } };
    },
    [logHistory, recargarPersonal]
  );

  /**
   * Cambia el rol de una persona con dos candados:
   *  - Nadie puede quitarse a sí mismo el rol de administrador (evita quedarse fuera).
   *  - La institución nunca puede quedarse sin ningún administrador.
   */
  const updateUserInfo: AppContextValue["updateUserInfo"] = useCallback(
    async (id, patch) => {
      if (!supabase) return "Supabase no está configurado";
      const dbPatch: Record<string, unknown> = {};
      if (patch.name !== undefined) {
        dbPatch.name = patch.name;
        dbPatch.initials = patch.name.split(" ").map((n) => n[0]).slice(0, 2).join("").toUpperCase();
      }
      if (patch.title !== undefined) dbPatch.title = patch.title || null;
      if (patch.area !== undefined) dbPatch.area = patch.area || null;
      const { error } = await supabase.from("profiles").update(dbPatch).eq("id", id);
      if (error) return error.message;
      setState((prev) => ({ ...prev, users: prev.users.map((u) => (u.id === id ? { ...u, ...patch } : u)) }));
      logHistory("actualizó los datos de", patch.name ?? "", "Equipo");
    },
    [logHistory]
  );

  const updateUserRole: AppContextValue["updateUserRole"] = useCallback(async (id, role) => {
    if (!supabase) return "Supabase no está configurado";
    const prev = stateRef.current;
    const objetivo = prev.users.find((u) => u.id === id);
    if (!objetivo) return "No se encontró a esa persona.";
    if (objetivo.role === role) return;

    if (role === "member" && objetivo.role === "admin") {
      if (id === prev.currentUserId) {
        return "No puedes quitarte a ti mismo el rol de administrador. Pídeselo a otro administrador.";
      }
      const admins = prev.users.filter((u) => u.role === "admin").length;
      if (admins <= 1) {
        return "Debe quedar al menos un administrador en la institución.";
      }
    }

    const { error } = await supabase.from("profiles").update({ role }).eq("id", id);
    if (error) return error.message;
    setState((p) => ({ ...p, users: p.users.map((u) => (u.id === id ? { ...u, role } : u)) }));
    logHistory(
      role === "admin" ? "nombró administrador a" : "cambió a miembro del equipo a",
      objetivo.name,
      "Equipo"
    );
    await notify(
      role === "admin" ? "Nuevo administrador" : "Cambio de rol",
      `${objetivo.name} ahora es ${role === "admin" ? "administrador" : "miembro del equipo"}`,
      "admins",
      false,
      "/equipo"
    );
    await notify(
      "Tu rol cambió",
      `Ahora eres ${role === "admin" ? "administrador" : "miembro del equipo"} en Staff Board`,
      [id],
      false,
      "/perfil"
    );
  }, [logHistory, notify]);

  /** Cada quien edita su propia ficha; se guarda de verdad en la base de datos. */
  const updateProfile: AppContextValue["updateProfile"] = useCallback(
    async (patch) => {
      if (!supabase) return;
      const id = stateRef.current.currentUserId;
      if (!id) return;
      const dbPatch: Record<string, unknown> = {};
      if (patch.name !== undefined) {
        dbPatch.name = patch.name;
        dbPatch.initials = patch.name.split(" ").map((n) => n[0]).slice(0, 2).join("").toUpperCase();
      }
      if (patch.title !== undefined) dbPatch.title = patch.title;
      if (patch.area !== undefined) dbPatch.area = patch.area;
      await supabase.from("profiles").update(dbPatch).eq("id", id);
      setState((prev) => ({
        ...prev,
        users: prev.users.map((u) => (u.id === id ? { ...u, ...patch } : u)),
      }));
      logHistory("actualizó su perfil", patch.name ?? "", "Equipo");
    },
    [logHistory]
  );

  /** Saca a alguien del equipo. Las protecciones reales viven en /api/remove-user. */
  const removeUser: AppContextValue["removeUser"] = useCallback(
    async (id) => {
      const persona = stateRef.current.users.find((u) => u.id === id);
      const res = await fetch("/api/remove-user", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: id, requesterId: stateRef.current.currentUserId }),
      });
      const body = await res.json();

      /* Siempre volvemos a leer el directorio: aunque algo falle a medias,
         la pantalla debe reflejar lo que de verdad hay en la base. */
      await recargarPersonal();

      if (!res.ok) return body.error ?? "No se pudo eliminar a esa persona.";
      await notify("Persona eliminada del equipo", `${currentUser?.name ?? "Alguien"} eliminó a ${persona?.name ?? "un colaborador"}`, "admins");
      if (body.aviso) return body.aviso;
    },
    [recargarPersonal, notify, currentUser]
  );

  /** Reenvía el correo para que la persona cree (o recupere) su contraseña. */
  const resendInvite: AppContextValue["resendInvite"] = useCallback(async (email) => {
    if (!supabase) return "Supabase no está configurado";
    const redirectTo = typeof window !== "undefined" ? `${window.location.origin}/auth/callback` : undefined;
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
    if (error) return error.message;
  }, []);

  const myNotifications = useMemo(
    () => state.notifications.filter((n) => n.audience === "all" || (Array.isArray(n.audience) && n.audience.includes(currentUser?.id ?? ""))),
    [state.notifications, currentUser]
  );

  /** Búsqueda global de la barra superior. Respeta lo que cada quien puede ver. */
  const searchAll: AppContextValue["searchAll"] = useCallback(
    (q) => {
      const term = q.trim().toLowerCase();
      if (term.length < 2) return { events: [], tasks: [], people: [] };
      const visible = state.events.filter(
        (e) => e.status === "publicado" || e.createdBy === currentUser?.id || isAdmin
      );
      const visibleIds = new Set(visible.map((e) => e.id));
      return {
        events: visible.filter((e) => `${e.name} ${e.description}`.toLowerCase().includes(term)).slice(0, 5),
        tasks: state.tasks
          .filter((t) => !t.archived && visibleIds.has(t.eventId) && `${t.name} ${t.description}`.toLowerCase().includes(term))
          .slice(0, 5),
        people: state.users
          .filter((u) => `${u.name} ${u.email} ${u.title ?? ""} ${u.area ?? ""}`.toLowerCase().includes(term))
          .slice(0, 5),
      };
    },
    [state.events, state.tasks, state.users, currentUser, isAdmin]
  );

  const hasEvidence: AppContextValue["hasEvidence"] = useCallback((task) => task.evidence.length + task.attachments.length > 0, []);
  const canFinishTask: AppContextValue["canFinishTask"] = useCallback(
    (task) => !state.settings.requireEvidence || hasEvidence(task),
    [state.settings.requireEvidence, hasEvidence]
  );

  /** Marca una sola notificación como leída (al tocarla en la campana). */
  const markNotificationRead: AppContextValue["markNotificationRead"] = useCallback(async (id) => {
    if (!supabase) return;
    const actual = stateRef.current.notifications.find((n) => n.id === id);
    if (!actual || actual.read) return;
    setState((prev) => ({
      ...prev,
      notifications: prev.notifications.map((n) => (n.id === id ? { ...n, read: true } : n)),
    }));
    await supabase.rpc("mark_notification_read", { p_notification_id: id });
  }, []);

  const markAllNotificationsRead: AppContextValue["markAllNotificationsRead"] = useCallback(async () => {
    if (!supabase) return;
    const unread = stateRef.current.notifications.filter((n) => !n.read);
    await Promise.all(unread.map((n) => supabase!.rpc("mark_notification_read", { p_notification_id: n.id })));
    setState((prev) => ({ ...prev, notifications: prev.notifications.map((n) => ({ ...n, read: true })) }));
  }, []);

  const sendPasswordLink: AppContextValue["sendPasswordLink"] = useCallback(async (email) => {
    if (!supabase) return "Falta conectar Supabase.";
    const redirectTo = typeof window !== "undefined" ? `${window.location.origin}/auth/callback` : undefined;
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo });
    if (error) return error.message;
  }, []);

  const changeMyPassword: AppContextValue["changeMyPassword"] = useCallback(async (nueva) => {
    if (!supabase) return "Supabase no está configurado";
    if (nueva.length < 8) return "La contraseña debe tener al menos 8 caracteres.";
    const { error } = await supabase.auth.updateUser({ password: nueva });
    if (error) return error.message;
  }, []);

  const login: AppContextValue["login"] = useCallback(async (email, password) => {
    if (!supabase) return "Falta conectar Supabase (revisa .env.local).";

    /* El correo se normaliza siempre: sin espacios y en minúsculas. Las cuentas
       se guardan así, y en el celular el teclado pone mayúscula a la primera
       letra sin que la persona se dé cuenta. Sin esto, la contraseña correcta
       parecía incorrecta. */
    const correo = email.trim().toLowerCase();
    if (!correo || !password) return "Escribe tu correo y tu contraseña.";

    const { error } = await supabase.auth.signInWithPassword({ email: correo, password });
    if (!error) return;

    /* Antes cualquier fallo decía "contraseña incorrecta", incluso cuando el
       problema era otro. Eso hacía imposible ayudar a alguien por teléfono. */
    const msg = (error.message ?? "").toLowerCase();
    if (msg.includes("invalid login") || msg.includes("invalid credentials")) {
      return "Correo o contraseña incorrectos. Revisa que no sobre ningún espacio y que las mayúsculas coincidan.";
    }
    if (msg.includes("not confirmed")) {
      return "Tu cuenta aún no está confirmada. Pídele a un administrador que la genere de nuevo.";
    }
    if (msg.includes("rate limit") || msg.includes("too many")) {
      return "Demasiados intentos seguidos. Espera un minuto y vuelve a probar.";
    }
    if (msg.includes("failed to fetch") || msg.includes("network")) {
      return "No hay conexión con el servidor. Revisa tu internet e inténtalo otra vez.";
    }
    return error.message;
  }, []);

  const logout: AppContextValue["logout"] = useCallback(async () => {
    // Limpiamos el estado local aunque la llamada a la red falle, para que
    // "Cerrar sesión" nunca deje a la persona atrapada dentro de la app.
    try {
      if (supabase) await supabase.auth.signOut();
    } catch {
      // sin conexión: igual cerramos la sesión de este dispositivo
    }
    setState({ ...emptyState, loading: false });
  }, []);

  /**
   * Mantenimiento automático: archiva lo vencido y avisa de fechas próximas.
   * Antes solo ocurría si alguien entraba a Configuración y guardaba, así que
   * en la práctica nunca pasaba. Lo corre un administrador, una vez por sesión,
   * porque es quien tiene permiso para modificar las tareas.
   */
  const mantenimientoHecho = useRef(false);
  useEffect(() => {
    if (!state.loggedIn || state.loading || mantenimientoHecho.current) return;
    if (currentUser?.role !== "admin") return;
    if (state.tasks.length === 0) return;
    mantenimientoHecho.current = true;
    const t = window.setTimeout(() => {
      runArchiveSweep();
      runDeadlineAlerts();
    }, 1500);
    return () => window.clearTimeout(t);
  }, [state.loggedIn, state.loading, state.tasks.length, currentUser, runArchiveSweep, runDeadlineAlerts]);

  const value: AppContextValue = {
    ...state,
    currentUser,
    isAdmin,
    eventById,
    tasksForEvent,
    userById,
    canSeeEvent,
    visibleEvents,
    wallEvents,
    myEvents,
    canEditEvent,
    canDeleteTask,
    createEvent,
    updateEvent,
    deleteEvent,
    duplicateEvent,
    createTask,
    updateTask,
    deleteTask,
    claimSlot,
    cancelSlot,
    confirmSlot,
    quitarInscripcion,
    joinWaitlist,
    leaveWaitlist,
    hasEvidence,
    canFinishTask,
    myNotifications,
    notify,
    liveTasks,
    runArchiveSweep,
    runDeadlineAlerts,
    setExecStatus,
    addChatMessage,
    refreshTaskChat,
    toggleReaction,
    deleteChatMessage,
    uploadFile,
    addEvidence,
    removeEvidence,
    monthNote,
    saveMonthNote,
    addCalendarEntry,
    llevarEventoAlCalendario,
    quitarEventoDelCalendario,
    fechaDeEvento,
    updateCalendarEntry,
    removeCalendarEntry,
    crearPizarra,
    guardarFilaPizarra,
    marcarFilaPizarra,
    cambiarEstadoPizarra,
    eliminarPizarra,
    updateSettings,
    addUser,
    resetUserPassword,
    updateUserRole,
    updateUserInfo,
    updateProfile,
    removeUser,
    resendInvite,
    searchAll,
    markNotificationRead,
    markAllNotificationsRead,
    sendPasswordLink,
    changeMyPassword,
    login,
    logout,
    logHistory,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used within AppProvider");
  return ctx;
}

export type { InstitutionSettings };
