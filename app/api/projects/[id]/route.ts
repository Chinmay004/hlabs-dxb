import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const project = await prisma.project.findUnique({
    where: { projectNumber: decodeURIComponent(id) },
  });
  if (!project) {
    return Response.json({ error: "project not found" }, { status: 404 });
  }
  return Response.json(project);
}
