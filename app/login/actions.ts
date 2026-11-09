"use server";

// Auth server actions for sign-up, login, and sign-out.
//
// These run on the server using our cookie-based server client, so each call
// acts AS the signed-in user (or anonymously, before login). With email
// confirmation ON, sign-up creates an unconfirmed account and no session until
// the user clicks the emailed link (handled by app/auth/confirm/route.ts).

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";

export type AuthState = { error?: string; message?: string };

export async function authenticate(
  _prevState: AuthState,
  formData: FormData,
): Promise<AuthState> {
  const intent = String(formData.get("intent") ?? "login");
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");

  if (!email || !password) {
    return { error: "Enter both your email and password." };
  }

  const supabase = await createClient();

  if (intent === "signup") {
    if (password.length < 6) {
      return { error: "Password must be at least 6 characters." };
    }

    const origin = (await headers()).get("origin") ?? "";
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: `${origin}/auth/confirm` },
    });

    if (error) {
      return { error: error.message };
    }

    // With confirmation ON and the "prevent user enumeration" default, an
    // already-registered email returns a user with an empty identities array
    // and no new email is sent. Surface a helpful message instead of a false
    // "check your email".
    if (data.user && (data.user.identities?.length ?? 0) === 0) {
      return {
        error: "That email is already registered. Try logging in instead.",
      };
    }

    return {
      message:
        `Account created. We sent a confirmation link to ${email}. ` +
        "Open it to finish signing up, then come back and log in.",
    };
  }

  // Default: log in an existing, confirmed account.
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    if (/confirm/i.test(error.message)) {
      return {
        error:
          "Your email isn't confirmed yet. Check your inbox for the " +
          "confirmation link, then try again.",
      };
    }
    return { error: error.message };
  }

  revalidatePath("/", "layout");
  redirect("/");
}

export async function signout(): Promise<void> {
  const supabase = await createClient();
  // scope 'local' ends only this session (not every device).
  await supabase.auth.signOut({ scope: "local" });
  revalidatePath("/", "layout");
  redirect("/login");
}
