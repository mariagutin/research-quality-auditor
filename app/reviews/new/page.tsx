// Entry point for starting a new check. Server component: it guarantees the
// visitor is signed in (otherwise there is no one to own the review) and then
// renders the client upload form.

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import UploadForm from "./upload-form";

export default async function NewReviewPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  return <UploadForm />;
}
